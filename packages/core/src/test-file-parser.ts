/**
 * Utilities for parsing test files to extract hooks and tests
 * Supports Playwright hooks: test.beforeAll, test.afterAll, test.beforeEach, test.afterEach
 */

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import generate from '@babel/generator';
import { createHash } from 'crypto';
import type { TestPathway } from './types';

/**
 * When emitting per-statement code for parsed tests/hooks, avoid Babel's default pretty-print
 * (e.g. splitting `{ exact: true }` across lines) so simplified-view units match the source file.
 */
const PARSED_STATEMENT_CODE_GEN_OPTS = { comments: false as const, retainLines: true };

export interface ParsedHook {
  code: string;  // The hook function body code
  name: string;  // Hook name for debugging
  suitePath?: string[];  // Array of suite names where hook is defined (empty for file-level hooks)
  scope: 'file' | 'suite';  // Explicit scope indicator
  statements: ParsedTestStatement[];  // Pre-parsed statements from hook body (extracted during initial parse)
}

export interface ParsedTestStatement {
  code: string;
  isVariableDeclaration: boolean;
  intentComment?: string;
  screenStateAnnotation?: string;
  scenarioAnnotation?: string;
  scenarioAnnotationLine?: number;
  /** True for synthetic rows prepended from @Scenario comments above the test() call */
  scenarioAnnotationOnly?: boolean;
  stepId?: string;  // Optional deterministic hash for AST node (for file-based execution annotation updates)
}

export interface ParsedTest {
  name: string;  // Test name (first argument to test())
  code: string;  // Test function body code (kept for constructTestScriptWithImports)
  suitePath?: string[];  // Array of suite names from root to current suite (empty for file-level tests)
  fullName: string;  // Full test name including suite prefix (e.g., "LoginSuite__testLogin")
  statements: ParsedTestStatement[];  // Pre-parsed statements from test body (extracted during initial parse)
  testBodyStartLine?: number;  // 1-based line number where test body starts (best-effort)
}

export interface ParsedSuite {
  name: string;  // Suite name (from test.describe() first argument)
  suitePath: string[];  // Full path from root (e.g., ["LoginSuite", "AuthTests"])
  beforeAll: ParsedHook[];
  afterAll: ParsedHook[];
  beforeEach: ParsedHook[];
  afterEach: ParsedHook[];
  tests: ParsedTest[];
  nestedSuites: ParsedSuite[];  // For nested describe blocks
  suiteVariables: string[];  // Suite-level variable declarations (e.g., "let signInPage;")
}

export interface ParsedTestFile {
  fileHooks: {  // Consolidated file-level hooks
    beforeAll: ParsedHook[];
    afterAll: ParsedHook[];
    beforeEach: ParsedHook[];
    afterEach: ParsedHook[];
  };
  tests: ParsedTest[];  // File-level tests (not in any describe block)
  suites: ParsedSuite[];  // Top-level suites
  fileVariables: string[];  // File-level variable declarations (e.g., "let globalVar;")
}

/**
 * Extract text from a comment, handling both CommentLine and CommentBlock types
 * @param comment - Babel comment object
 * @returns Extracted comment text with markers stripped if needed
 */
export function extractCommentText(comment: any): string {
  if (!comment || !comment.value) {
    return '';
  }
  let text = comment.value.trim();
  
  // For CommentBlock, strip /* and */ markers if present
  if (comment.type === 'CommentBlock') {
    text = text.replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim();
  }
  
  return text;
}

function extractScenarioAnnotation(commentText: string): string | undefined {
  const marker = '@Scenario';
  const markerIndex = commentText.indexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }
  const afterMarker = commentText.slice(markerIndex + marker.length);
  const colonIndex = afterMarker.indexOf(':');
  if (colonIndex === -1) {
    return undefined;
  }
  const title = afterMarker.slice(colonIndex + 1).trim();
  return title.length > 0 ? title : undefined;
}

export interface ScenarioAnnotationComponents {
  ordinalId?: string; // numeric string e.g. "101"
  title?: string;
}

function cleanAnnotationFirstPart(part: string): string {
  let cleaned = part.trim();
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  cleaned = cleaned.replace(/[.;]+$/, '').trim();
  return cleaned;
}

export function parseScenarioAnnotationComponents(annotation: string): ScenarioAnnotationComponents {
  const trimmed = annotation.trim();
  if (!trimmed) {
    return {};
  }
  const spaceMatch = trimmed.match(/^(\S+)(\s+)([\s\S]*)$/);
  if (!spaceMatch) {
    // Single token — no whitespace
    const cleaned = cleanAnnotationFirstPart(trimmed);
    if (cleaned.startsWith('#TS-')) {
      const ordinalId = cleaned.slice(4);
      return ordinalId ? { ordinalId } : {};
    }
    return cleaned ? { title: cleaned } : {};
  }
  // Has whitespace: first token + rest
  const firstPart = cleanAnnotationFirstPart(spaceMatch[1]);
  const rest = spaceMatch[3].trim();
  if (firstPart.startsWith('#TS-')) {
    const ordinalId = firstPart.slice(4);
    return {
      ordinalId: ordinalId || undefined,
      title: rest || undefined,
    };
  }
  // First part is not an ordinalId — whole thing is the title
  return { title: trimmed };
}

const TEST_MODIFIER_NAMES = new Set(['only', 'skip', 'fixme']);

/** Whether a CallExpression callee is test(...) or test.only/skip/fixme(...). */
export function isTestCall(callee: t.Expression | t.V8IntrinsicIdentifier): boolean {
  if (t.isIdentifier(callee) && callee.name === 'test') {
    return true;
  }
  if (t.isMemberExpression(callee)) {
    const object = callee.object;
    const property = callee.property;
    if (t.isIdentifier(object) && object.name === 'test' && t.isIdentifier(property)) {
      return TEST_MODIFIER_NAMES.has(property.name);
    }
  }
  return false;
}

function canonicalScenarioTitle(annotation: string): string {
  const components = parseScenarioAnnotationComponents(annotation);
  return components.title ??
    (components.ordinalId ? `#TS-${components.ordinalId}` : annotation.trim());
}

/** Same canonical title logic used when upserting smarttest_scenario_mappings. */
export function canonicalScenarioTitleForMapping(annotation: string): string {
  return canonicalScenarioTitle(annotation);
}

function collectScenarioDedupeKeys(annotation: string): string[] {
  const components = parseScenarioAnnotationComponents(annotation);
  const keys = [canonicalScenarioTitle(annotation)];
  if (components.ordinalId) {
    keys.push(`ordinal:${components.ordinalId}`);
  }
  return keys;
}

function buildScenarioDedupeKeySet(annotations: Iterable<string | undefined>): Set<string> {
  const keys = new Set<string>();
  for (const annotation of annotations) {
    if (!annotation) {
      continue;
    }
    for (const key of collectScenarioDedupeKeys(annotation)) {
      keys.add(key);
    }
  }
  return keys;
}

function extractScenarioAnnotationsFromComments(
  comments: readonly unknown[] | null | undefined
): Array<{ scenarioAnnotation: string; scenarioAnnotationLine?: number }> {
  const results: Array<{ scenarioAnnotation: string; scenarioAnnotationLine?: number }> = [];
  if (!comments || !Array.isArray(comments)) {
    return results;
  }
  for (const comment of comments) {
    const commentText = extractCommentText(comment);
    const scenarioTitle = extractScenarioAnnotation(commentText);
    if (scenarioTitle) {
      results.push({
        scenarioAnnotation: scenarioTitle,
        scenarioAnnotationLine: (comment as { loc?: { start?: { line?: number } } }).loc?.start?.line
      });
    }
  }
  return results;
}

export class TestFileParser {

  /**
   * Merge @Scenario comments on the test() call (immediately above, no statements between)
   * into the parsed statement list as synthetic annotation-only rows.
   */
  static applyPreTestScenarioAnnotations(
    statements: ParsedTestStatement[],
    testCallPath: { node: { leadingComments?: readonly unknown[] }; parentPath?: { isExpressionStatement?: () => boolean; node: { leadingComments?: readonly unknown[] } } }
  ): ParsedTestStatement[] {
    const parent = testCallPath.parentPath;
    // Babel attaches leading comments to the ExpressionStatement wrapper; avoid reading both parent and call.
    const leadingComments = parent?.isExpressionStatement?.()
      ? parent.node.leadingComments
      : testCallPath.node.leadingComments;
    const preTestScenarios = extractScenarioAnnotationsFromComments(leadingComments);

    if (preTestScenarios.length === 0) {
      return statements;
    }

    const bodyKeys = buildScenarioDedupeKeySet(statements.map((s) => s.scenarioAnnotation));
    const prependedKeys = new Set<string>();
    const toPrepend: ParsedTestStatement[] = [];
    for (const preTest of preTestScenarios) {
      const preKeys = collectScenarioDedupeKeys(preTest.scenarioAnnotation);
      if (preKeys.some((key) => bodyKeys.has(key) || prependedKeys.has(key))) {
        continue;
      }
      for (const key of preKeys) {
        prependedKeys.add(key);
      }
      toPrepend.push({
        code: '',
        isVariableDeclaration: false,
        scenarioAnnotationOnly: true,
        scenarioAnnotation: preTest.scenarioAnnotation,
        scenarioAnnotationLine: preTest.scenarioAnnotationLine
      });
    }

    if (toPrepend.length === 0) {
      return statements;
    }
    return [...toPrepend, ...statements];
  }

  /**
   * Generate full test name with suite prefix
   * @param suitePath - Array of suite names from root to current suite
   * @param testName - Original test name
   * @returns Full test name with suite prefix (e.g., "LoginSuite__testLogin")
   */
  static generateTestFullName(suitePath: string[], testName: string): string {
    if (suitePath.length === 0) {
      return testName;
    }
    return `${suitePath.join('__')}__${testName}`;
  }

  /**
   * Find all parent describe blocks for a given AST path
   * @param path - Babel AST path
   * @returns Array of suite names from root to current (empty if not in any describe block)
   */
  static findSuitePath(path: any): string[] {
    const suitePath: string[] = [];
    let currentPath = path.parentPath;
    
    while (currentPath) {
      // Check if current path is a test.describe() call
      if (currentPath.isCallExpression()) {
        const callee = currentPath.node.callee;
        if (t.isMemberExpression(callee)) {
          const object = callee.object;
          const property = callee.property;
          
          if (t.isIdentifier(object) && object.name === 'test' && 
              t.isIdentifier(property) && property.name === 'describe') {
            // Extract suite name from first argument
            if (currentPath.node.arguments.length >= 1) {
              const suiteNameArg = currentPath.node.arguments[0];
              let suiteName: string | null = null;
              
              if (t.isStringLiteral(suiteNameArg)) {
                suiteName = suiteNameArg.value;
              } else if (t.isTemplateLiteral(suiteNameArg)) {
                if (suiteNameArg.quasis.length > 0) {
                  suiteName = suiteNameArg.quasis[0].value.raw;
                }
              }
              
              if (suiteName) {
                suitePath.unshift(suiteName);  // Add to beginning (root first)
              }
            }
          }
        }
      }
      
      currentPath = currentPath.parentPath;
    }
    
    return suitePath;
  }

  /**
   * Extract statements from a function body (BlockStatement or Expression)
   * @param body - The function body (BlockStatement or Expression)
   * @param generateStepIds - Whether to generate stepIds for statements (for tests, not hooks)
   * @returns Object containing parsed statements and body code
   */
  private static extractStatementsFromFunctionBody(
    body: t.BlockStatement | t.Expression,
    generateStepIds: boolean = false
  ): { statements: ParsedTestStatement[]; bodyCode: string } {
    if (t.isBlockStatement(body)) {
      // Extract all statements from BlockStatement.body
      const bodyStatements = body.body;
      
      // Generate cumulative code for hashing (only if generating stepIds)
      let cumulativeCode = '';
      
      const statements = bodyStatements.map((stmt, index): ParsedTestStatement => {
        const code = generate(stmt, PARSED_STATEMENT_CODE_GEN_OPTS).code.trim();
        
        // Build cumulative code and generate stepId if requested
        let stepId: string | undefined;
        if (generateStepIds) {
          cumulativeCode += (cumulativeCode ? '\n' : '') + code;
          stepId = createHash('sha256').update(cumulativeCode).digest('hex');
        }
        
        // Mark as non-reportable if it's a variable declaration OR an assignment expression
        const isVar = t.isVariableDeclaration(stmt) || 
                     (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression));
        
        // Extract intent comment (leading comment, exclude @Screen/@State/@Scenario)
        let intentComment: string | undefined;
        try {
          const leadingComments = (stmt as any).leadingComments;
          if (leadingComments && Array.isArray(leadingComments) && leadingComments.length > 0) {
            for (const comment of leadingComments) {
              const commentText = extractCommentText(comment);
              if (commentText && !commentText.includes('@Screen') && !commentText.includes('@State') && !commentText.includes('@Scenario')) {
                intentComment = commentText;
                break;
              }
            }
          }
        } catch (e) {
          // Comments not available, skip
        }

        // Extract scenario annotation (leading comment only)
        let scenarioAnnotation: string | undefined;
        let scenarioAnnotationLine: number | undefined;
        try {
          const leadingComments = (stmt as any).leadingComments;
          if (leadingComments && Array.isArray(leadingComments) && leadingComments.length > 0) {
            for (const comment of leadingComments) {
              const commentText = extractCommentText(comment);
              const scenarioTitle = extractScenarioAnnotation(commentText);
              if (scenarioTitle) {
                scenarioAnnotation = scenarioTitle;
                scenarioAnnotationLine = comment.loc?.start?.line;
                break;
              }
            }
          }
        } catch (e) {
          // Comments not available, skip
        }
        
        // Extract screen-state annotation (trailing or next statement's leading)
        let screenStateAnnotation: string | undefined;
        try {
          const trailingComments = (stmt as any).trailingComments;
          if (trailingComments && Array.isArray(trailingComments) && trailingComments.length > 0) {
            for (const comment of trailingComments) {
              const commentText = extractCommentText(comment);
              if (commentText && (commentText.includes('@Screen') || commentText.includes('@State'))) {
                screenStateAnnotation = commentText;
                break;
              }
            }
          }
        } catch (e) {
          // Comments not available, skip
        }
        
        // Fallback: check next statement's leading @Screen/@State comment
        if (!screenStateAnnotation && index + 1 < bodyStatements.length) {
          try {
            const nextStmt = bodyStatements[index + 1];
            const nextLeadingComments = (nextStmt as any).leadingComments;
            if (nextLeadingComments && Array.isArray(nextLeadingComments) && nextLeadingComments.length > 0) {
              for (const comment of nextLeadingComments) {
                const commentText = extractCommentText(comment);
                if (commentText && (commentText.includes('@Screen') || commentText.includes('@State'))) {
                  screenStateAnnotation = commentText;
                  break;
                }
              }
            }
          } catch (e) {
            // Comments not available, skip
          }
        }
        
        const result: ParsedTestStatement = {
          code,
          isVariableDeclaration: isVar,
          intentComment,
          screenStateAnnotation,
          scenarioAnnotation,
          scenarioAnnotationLine
        };
        
        if (stepId) {
          result.stepId = stepId;
        }
        
        return result;
      });
      
      // Generate body code
      const bodyCode = generate(body, PARSED_STATEMENT_CODE_GEN_OPTS).code;
      
      return { statements, bodyCode };
    } else {
      // Expression body - single statement
      const exprCode = generate(body, PARSED_STATEMENT_CODE_GEN_OPTS).code.trim();
      const bodyCode = `{ return ${exprCode}; }`;
      
      let stepId: string | undefined;
      if (generateStepIds) {
        stepId = createHash('sha256').update(exprCode).digest('hex');
      }
      
      const statement: ParsedTestStatement = {
        code: exprCode,
        isVariableDeclaration: false
      };
      
      if (stepId) {
        statement.stepId = stepId;
      }
      
      return { statements: [statement], bodyCode };
    }
  }

  /**
   * Parse a test file to extract hooks and tests, supporting test.describe() blocks
   * @param script - The test file content
   * @param testPathways - Optional array of test pathways to filter (suite path + test name)
   * @returns Parsed structure with hooks and tests
   */
  static parseTestFile(
    script: string,
    testPathways?: TestPathway[]
  ): ParsedTestFile {
    const result: ParsedTestFile = {
      fileHooks: {
        beforeAll: [],
        afterAll: [],
        beforeEach: [],
        afterEach: []
      },
      tests: [],
      suites: [],
      fileVariables: []
    };

    try {
      // Parse the script with Babel
      const ast = parse(script, {
        sourceType: 'module',
        plugins: ['typescript', 'classProperties', 'decorators-legacy'],
        allowImportExportEverywhere: true
      });

      // Track if we should filter tests
      const shouldFilter = testPathways && testPathways.length > 0;
      const pathwaySet = shouldFilter ? new Set(
        testPathways.map(p => JSON.stringify({ 
          suitePath: p.suitePath || [], 
          testName: p.testName.trim() 
        }))
      ) : null;

      // Map to store suites by their path (for nested suite tracking)
      const suiteMap = new Map<string, ParsedSuite>();

      /**
       * Recursively parse a suite (describe block) and its nested suites
       */
      const parseSuite = (describePath: any, parentSuitePath: string[]): ParsedSuite | null => {
        if (!describePath.isCallExpression()) {
          return null;
        }

        const callee = describePath.node.callee;
        if (!t.isMemberExpression(callee)) {
          return null;
        }

        const object = callee.object;
        const property = callee.property;
        
        if (!t.isIdentifier(object) || object.name !== 'test' || 
            !t.isIdentifier(property) || property.name !== 'describe') {
          return null;
        }

        // Extract suite name
        if (describePath.node.arguments.length < 2) {
          return null;
        }

        const suiteNameArg = describePath.node.arguments[0];
        let suiteName: string | null = null;
        
        if (t.isStringLiteral(suiteNameArg)) {
          suiteName = suiteNameArg.value;
        } else if (t.isTemplateLiteral(suiteNameArg)) {
          if (suiteNameArg.quasis.length > 0) {
            suiteName = suiteNameArg.quasis[0].value.raw;
          }
        }

        if (!suiteName) {
          return null;
        }

        // Build current suite path
        const currentSuitePath = [...parentSuitePath, suiteName];
        const suitePathKey = currentSuitePath.join('__');

        // Check if suite already exists (shouldn't happen, but safety check)
        if (suiteMap.has(suitePathKey)) {
          return suiteMap.get(suitePathKey)!;
        }

        // Create new suite
        const suite: ParsedSuite = {
          name: suiteName,
          suitePath: currentSuitePath,
          beforeAll: [],
          afterAll: [],
          beforeEach: [],
          afterEach: [],
          tests: [],
          nestedSuites: [],
          suiteVariables: []  // Will be populated during traversal
        };

        suiteMap.set(suitePathKey, suite);

        // Get callback function (second argument)
        const callback = describePath.node.arguments[1];
        if (!t.isFunctionExpression(callback) && !t.isArrowFunctionExpression(callback)) {
          return suite;
        }

        // Traverse the callback body to find hooks, tests, nested describe blocks, and suite-level variables
        // Use path.traverse() to maintain proper context (scope and parentPath)
        const callbackPath = describePath.get('arguments')[1];
        if (callbackPath.isFunctionExpression() || callbackPath.isArrowFunctionExpression()) {
          const bodyPath = callbackPath.get('body');
          if (bodyPath.isBlockStatement()) {
            // Track which statements are inside hooks/tests/nested describes
            const statementsInsideNestedBlocks = new Set<any>();
            
            // Use path.traverse() which maintains the proper scope and parentPath context
            bodyPath.traverse({
          CallExpression(path: any) {
            // Mark this path and its children as inside a nested block
            path.traverse({
              enter(p: any) {
                statementsInsideNestedBlocks.add(p.node);
              }
            });
            const callee = path.node.callee;
            
            // Check for test.beforeAll, test.afterAll, test.beforeEach, test.afterEach
            if (t.isMemberExpression(callee)) {
              const object = callee.object;
              const property = callee.property;
              
              if (t.isIdentifier(object) && object.name === 'test' && t.isIdentifier(property)) {
                const hookName = property.name;
                
                // Check if this is a hook
                if (hookName === 'beforeAll' || hookName === 'afterAll' || 
                    hookName === 'beforeEach' || hookName === 'afterEach') {
                  // Get the callback function
                  if (path.node.arguments.length >= 1) {
                    const hookCallback = path.node.arguments[0];
                    
                    if (t.isFunctionExpression(hookCallback) || t.isArrowFunctionExpression(hookCallback)) {
                      let hookBody: string;
                      let statements: ParsedTestStatement[];
                      
                      if (t.isBlockStatement(hookCallback.body)) {
                        hookBody = generate(hookCallback.body, PARSED_STATEMENT_CODE_GEN_OPTS).code;
                        
                        // Extract ALL statements from BlockStatement.body (includes variables)
                        const blockBody = hookCallback.body as t.BlockStatement;
                        const bodyStatements = blockBody.body;
                        statements = bodyStatements.map((stmt, index): ParsedTestStatement => {
                          const code = generate(stmt, PARSED_STATEMENT_CODE_GEN_OPTS).code.trim();
                          // Mark as non-reportable if it's a variable declaration OR an assignment expression
                          const isVar = t.isVariableDeclaration(stmt) || 
                                       (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression));
                          
                          // Extract intent comment (leading comment, exclude @Screen/@State)
                          let intentComment: string | undefined;
                          try {
                            const leadingComments = (stmt as any).leadingComments;
                            if (leadingComments && Array.isArray(leadingComments) && leadingComments.length > 0) {
                              for (const comment of leadingComments) {
                                const commentText = extractCommentText(comment);
                                if (commentText && !commentText.includes('@Screen') && !commentText.includes('@State')) {
                                  intentComment = commentText;
                                  break;
                                }
                              }
                            }
                          } catch (e) {
                            // Comments not available, skip
                          }
                          
                          // Extract screen-state annotation (trailing or next statement's leading)
                          let screenStateAnnotation: string | undefined;
                          try {
                            const trailingComments = (stmt as any).trailingComments;
                            if (trailingComments && Array.isArray(trailingComments) && trailingComments.length > 0) {
                              for (const comment of trailingComments) {
                                const commentText = extractCommentText(comment);
                                if (commentText && (commentText.includes('@Screen') || commentText.includes('@State'))) {
                                  screenStateAnnotation = commentText;
                                  break;
                                }
                              }
                            }
                          } catch (e) {
                            // Comments not available, skip
                          }
                          
                          // Fallback: check next statement's leading @Screen/@State comment
                          if (!screenStateAnnotation && index + 1 < bodyStatements.length) {
                            try {
                              const nextStmt = bodyStatements[index + 1];
                              const nextLeadingComments = (nextStmt as any).leadingComments;
                              if (nextLeadingComments && Array.isArray(nextLeadingComments) && nextLeadingComments.length > 0) {
                                for (const comment of nextLeadingComments) {
                                  const commentText = extractCommentText(comment);
                                  if (commentText && (commentText.includes('@Screen') || commentText.includes('@State'))) {
                                    screenStateAnnotation = commentText;
                                    break;
                                  }
                                }
                              }
                            } catch (e) {
                              // Comments not available, skip
                            }
                          }
                          
                          return { code, isVariableDeclaration: isVar, intentComment, screenStateAnnotation };
                        });
                      } else {
                        // Expression body - single statement
                        const exprCode = generate(hookCallback.body, PARSED_STATEMENT_CODE_GEN_OPTS).code.trim();
                        hookBody = `{ return ${exprCode}; }`;
                        statements = [{
                          code: exprCode,
                          isVariableDeclaration: false
                        }];
                      }
                      
                      const hook: ParsedHook = {
                        code: hookBody,
                        name: hookName,
                        suitePath: currentSuitePath,
                        scope: 'suite',
                        statements: statements
                      };
                      
                      // Add to suite's appropriate array
                      if (hookName === 'beforeAll') {
                        suite.beforeAll.push(hook);
                      } else if (hookName === 'afterAll') {
                        suite.afterAll.push(hook);
                      } else if (hookName === 'beforeEach') {
                        suite.beforeEach.push(hook);
                      } else if (hookName === 'afterEach') {
                        suite.afterEach.push(hook);
                      }
                    }
                  }
                  return;
                }
              }
            }
            
            // Check for test() calls (including test.only/skip/fixme)
            if (isTestCall(callee)) {
              if (path.node.arguments.length >= 2) {
                const testNameArg = path.node.arguments[0];
                const testCallback = path.node.arguments[1];
                
                // Extract test name
                let testName: string | null = null;
                if (t.isStringLiteral(testNameArg)) {
                  testName = testNameArg.value;
                } else if (t.isTemplateLiteral(testNameArg)) {
                  if (testNameArg.quasis.length > 0) {
                    testName = testNameArg.quasis[0].value.raw;
                  }
                }
                
                if (testName) {
                  const fullName = TestFileParser.generateTestFullName(currentSuitePath, testName);
                  
                  // Filter tests if testPathways provided
                  if (shouldFilter && pathwaySet) {
                    const testPathway = JSON.stringify({ 
                      suitePath: currentSuitePath || [], 
                      testName: testName.trim() 
                    });
                    if (!pathwaySet.has(testPathway)) {
                      return; // Skip this test
                    }
                  }
                  
                  // Extract test body
                  if (t.isFunctionExpression(testCallback) || t.isArrowFunctionExpression(testCallback)) {
                    const { statements, bodyCode } = TestFileParser.extractStatementsFromFunctionBody(
                      testCallback.body,
                      true  // Generate stepIds for tests
                    );
                    const mergedStatements = TestFileParser.applyPreTestScenarioAnnotations(statements, path);
                    const testBody = bodyCode;
                    
                    suite.tests.push({
                      name: testName,
                      code: testBody,
                      suitePath: currentSuitePath,
                      fullName: fullName,
                      statements: mergedStatements,
                      testBodyStartLine: testCallback.body.loc?.start?.line
                    });
                  }
                }
              }
              return;
            }
            
            // Check for nested test.describe() calls
            if (t.isMemberExpression(callee)) {
              const object = callee.object;
              const property = callee.property;
              
              if (t.isIdentifier(object) && object.name === 'test' && 
                  t.isIdentifier(property) && property.name === 'describe') {
                // This is a nested describe block - parse it recursively
                const nestedSuite = parseSuite(path, currentSuitePath);
                if (nestedSuite) {
                  suite.nestedSuites.push(nestedSuite);
                }
                return;
              }
            }
          },
          VariableDeclaration(path: any) {
            // Extract suite-level variable declarations
            // Only collect if this VariableDeclaration is a direct child of the suite callback body
            const parent = path.parentPath;
            if (parent && parent.isBlockStatement() && parent.node === bodyPath.node) {
              // This is a direct child of the suite callback body - it's a suite-level variable
              const varCode = generate(path.node, { comments: false }).code;
              suite.suiteVariables.push(varCode);
            }
          }
            });
          }
        }

        return suite;
      };

      // Track which statements are inside describe/hook/test blocks (to exclude from file variables)
      const statementsInsideBlocks = new Set<any>();

      // Traverse the AST to find top-level hooks, tests, and describe blocks
      traverse(ast, {
        CallExpression(path: any) {
          // Mark this path and its children as inside a block
          path.traverse({
            enter(p: any) {
              statementsInsideBlocks.add(p.node);
            }
          });
          
          const callee = path.node.callee;
          
          // Check for test.describe() at top level
          if (t.isMemberExpression(callee)) {
            const object = callee.object;
            const property = callee.property;
            
            if (t.isIdentifier(object) && object.name === 'test' && 
                t.isIdentifier(property) && property.name === 'describe') {
              // Check if this is at the top level (not nested in another describe)
              const suitePath = TestFileParser.findSuitePath(path);
              if (suitePath.length === 0) {
                // This is a top-level describe block
                const suite = parseSuite(path, []);
                if (suite) {
                  result.suites.push(suite);
                }
              }
              return;
            }
          }
          
          // Check for file-level hooks (test.beforeAll, etc.) - not inside any describe block
          if (t.isMemberExpression(callee)) {
            const object = callee.object;
            const property = callee.property;
            
            if (t.isIdentifier(object) && object.name === 'test' && t.isIdentifier(property)) {
              const hookName = property.name;
              
              if (hookName === 'beforeAll' || hookName === 'afterAll' || 
                  hookName === 'beforeEach' || hookName === 'afterEach') {
                // Check if this hook is at file level (not inside any describe block)
                const suitePath = TestFileParser.findSuitePath(path);
                if (suitePath.length === 0) {
                  // This is a file-level hook
                  if (path.node.arguments.length >= 1) {
                    const callback = path.node.arguments[0];
                    
                    if (t.isFunctionExpression(callback) || t.isArrowFunctionExpression(callback)) {
                      let hookBody: string;
                      let statements: ParsedTestStatement[];
                      
                      if (t.isBlockStatement(callback.body)) {
                        hookBody = generate(callback.body, PARSED_STATEMENT_CODE_GEN_OPTS).code;
                        
                        // Extract ALL statements from BlockStatement.body (includes variables)
                        const blockBody = callback.body as t.BlockStatement;
                        const bodyStatements = blockBody.body;
                        statements = bodyStatements.map((stmt, index): ParsedTestStatement => {
                          const code = generate(stmt, PARSED_STATEMENT_CODE_GEN_OPTS).code.trim();
                          // Mark as non-reportable if it's a variable declaration OR an assignment expression
                          const isVar = t.isVariableDeclaration(stmt) || 
                                       (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression));
                          
                          // Extract intent comment (leading comment, exclude @Screen/@State)
                          let intentComment: string | undefined;
                          try {
                            const leadingComments = (stmt as any).leadingComments;
                            if (leadingComments && Array.isArray(leadingComments) && leadingComments.length > 0) {
                              for (const comment of leadingComments) {
                                const commentText = extractCommentText(comment);
                                if (commentText && !commentText.includes('@Screen') && !commentText.includes('@State')) {
                                  intentComment = commentText;
                                  break;
                                }
                              }
                            }
                          } catch (e) {
                            // Comments not available, skip
                          }
                          
                          // Extract screen-state annotation (trailing or next statement's leading)
                          let screenStateAnnotation: string | undefined;
                          try {
                            const trailingComments = (stmt as any).trailingComments;
                            if (trailingComments && Array.isArray(trailingComments) && trailingComments.length > 0) {
                              for (const comment of trailingComments) {
                                const commentText = extractCommentText(comment);
                                if (commentText && (commentText.includes('@Screen') || commentText.includes('@State'))) {
                                  screenStateAnnotation = commentText;
                                  break;
                                }
                              }
                            }
                          } catch (e) {
                            // Comments not available, skip
                          }
                          
                          // Fallback: check next statement's leading @Screen/@State comment
                          if (!screenStateAnnotation && index + 1 < bodyStatements.length) {
                            try {
                              const nextStmt = bodyStatements[index + 1];
                              const nextLeadingComments = (nextStmt as any).leadingComments;
                              if (nextLeadingComments && Array.isArray(nextLeadingComments) && nextLeadingComments.length > 0) {
                                for (const comment of nextLeadingComments) {
                                  const commentText = extractCommentText(comment);
                                  if (commentText && (commentText.includes('@Screen') || commentText.includes('@State'))) {
                                    screenStateAnnotation = commentText;
                                    break;
                                  }
                                }
                              }
                            } catch (e) {
                              // Comments not available, skip
                            }
                          }
                          
                          return { code, isVariableDeclaration: isVar, intentComment, screenStateAnnotation };
                        });
                      } else {
                        // Expression body - single statement
                        const exprCode = generate(callback.body, PARSED_STATEMENT_CODE_GEN_OPTS).code.trim();
                        hookBody = `{ return ${exprCode}; }`;
                        statements = [{
                          code: exprCode,
                          isVariableDeclaration: false
                        }];
                      }
                      
                      const hook: ParsedHook = {
                        code: hookBody,
                        name: hookName,
                        suitePath: [],
                        scope: 'file',
                        statements: statements
                      };
                      
                      // Add to appropriate array
                      if (hookName === 'beforeAll') {
                        result.fileHooks.beforeAll.push(hook);
                      } else if (hookName === 'afterAll') {
                        result.fileHooks.afterAll.push(hook);
                      } else if (hookName === 'beforeEach') {
                        result.fileHooks.beforeEach.push(hook);
                      } else if (hookName === 'afterEach') {
                        result.fileHooks.afterEach.push(hook);
                      }
                    }
                  }
                }
                return;
              }
            }
          }
          
          // Check for file-level test() calls (not inside any describe block)
          if (isTestCall(callee)) {
            // Check if this test is at file level
            const suitePath = TestFileParser.findSuitePath(path);
            if (suitePath.length === 0) {
              // This is a file-level test
              if (path.node.arguments.length >= 2) {
                const testNameArg = path.node.arguments[0];
                const testCallback = path.node.arguments[1];
                
                // Extract test name
                let testName: string | null = null;
                if (t.isStringLiteral(testNameArg)) {
                  testName = testNameArg.value;
                } else if (t.isTemplateLiteral(testNameArg)) {
                  if (testNameArg.quasis.length > 0) {
                    testName = testNameArg.quasis[0].value.raw;
                  }
                }
                
                if (testName) {
                  const fullName = TestFileParser.generateTestFullName([], testName);
                  
                  // Filter tests if testPathways provided (match by suite path and test name)
                  if (shouldFilter && pathwaySet) {
                    const testPathway = JSON.stringify({ 
                      suitePath: [], 
                      testName: testName 
                    });
                    if (!pathwaySet.has(testPathway)) {
                      return; // Skip this test
                    }
                  }
                  
                  // Extract test body
                  if (t.isFunctionExpression(testCallback) || t.isArrowFunctionExpression(testCallback)) {
                    const { statements, bodyCode } = TestFileParser.extractStatementsFromFunctionBody(
                      testCallback.body,
                      true  // Generate stepIds for tests (THIS IS THE FIX)
                    );
                    const mergedStatements = TestFileParser.applyPreTestScenarioAnnotations(statements, path);
                    const testBody = bodyCode;
                    
                    result.tests.push({
                      name: testName,
                      code: testBody,
                      suitePath: [],
                      fullName: fullName,
                      statements: mergedStatements,
                      testBodyStartLine: testCallback.body.loc?.start?.line
                    });
                  }
                }
              }
            }
          }
        },
        VariableDeclaration(path: any) {
          // Extract file-level variable declarations
          // Only collect if this VariableDeclaration is a direct child of the Program body
          const parent = path.parentPath;
          if (parent && parent.isProgram()) {
            // This is a direct child of the Program body - it's a file-level variable
            // Check if it's not inside a describe/hook/test block
            if (!statementsInsideBlocks.has(path.node)) {
              const varCode = generate(path.node, { comments: false }).code;
              result.fileVariables.push(varCode);
            }
          }
        }
      });
    } catch (error) {
      throw new Error(`Failed to parse test file: ${error instanceof Error ? error.message : String(error)}`);
    }

    return result;
  }

  /**
   * Flatten suite structure into execution-ready format
   * Separates per-test hooks (beforeEach/afterEach) from per-suite hooks (beforeAll/afterAll)
   * @param parsed - Parsed test file structure
   * @returns Flattened structure ready for execution
   */
  static flattenForExecution(parsed: ParsedTestFile): {
    fileLevelHooks: {
      beforeAll: ParsedHook[];
      afterAll: ParsedHook[];
      beforeEach: ParsedHook[];
      afterEach: ParsedHook[];
    };
    fileVariables: string[];  // File-level variable declarations
    tests: Array<{
      test: ParsedTest;
      suitePath: string[];
      suiteBeforeEachHooks: ParsedHook[];
      suiteAfterEachHooks: ParsedHook[];
      suiteVariables: string[];  // All suite-level variables from parent suites (in order: parent → child)
    }>;
    suites: Array<{
      suitePath: string[];
      beforeAll: ParsedHook[];
      afterAll: ParsedHook[];
      testIndices: number[];
      suiteVariables: string[];  // Suite-level variables for this suite
    }>;
  } {
    const result = {
      fileLevelHooks: {
        beforeAll: parsed.fileHooks.beforeAll,
        afterAll: parsed.fileHooks.afterAll,
        beforeEach: parsed.fileHooks.beforeEach,
        afterEach: parsed.fileHooks.afterEach
      },
      fileVariables: parsed.fileVariables,
      tests: [] as Array<{
        test: ParsedTest;
        suitePath: string[];
        suiteBeforeEachHooks: ParsedHook[];
        suiteAfterEachHooks: ParsedHook[];
        suiteVariables: string[];
      }>,
      suites: [] as Array<{
        suitePath: string[];
        beforeAll: ParsedHook[];
        afterAll: ParsedHook[];
        testIndices: number[];
        suiteVariables: string[];
      }>
    };

    let testIndex = 0;

    /**
     * Recursively collect tests and hooks from a suite and its nested suites
     * Returns the test indices collected (including from nested suites)
     */
    const collectFromSuite = (suite: ParsedSuite, parentBeforeEach: ParsedHook[], parentAfterEach: ParsedHook[], parentVariables: string[]): number[] => {
      // Collect beforeEach/afterEach hooks from this suite (parent hooks first)
      const suiteBeforeEach = [...parentBeforeEach, ...suite.beforeEach];
      const suiteAfterEach = [...suite.afterEach, ...parentAfterEach]; // Reverse order for afterEach
      
      // Collect suite variables from this suite (parent variables first)
      const suiteVariables = [...parentVariables, ...suite.suiteVariables];

      // Track test indices for this suite (includes tests from this suite and nested suites)
      const suiteTestIndices: number[] = [];

      // Add tests from this suite
      for (const test of suite.tests) {
        suiteTestIndices.push(testIndex);
        result.tests.push({
          test: test,
          suitePath: test.suitePath || [],
          suiteBeforeEachHooks: suiteBeforeEach,
          suiteAfterEachHooks: suiteAfterEach,
          suiteVariables: suiteVariables
        });
        testIndex++;
      }

      // Process nested suites and collect their test indices
      for (const nestedSuite of suite.nestedSuites) {
        const nestedTestIndices = collectFromSuite(nestedSuite, suiteBeforeEach, suiteAfterEach, suiteVariables);
        // Include nested suite test indices in parent suite's test indices
        // (needed for afterAll execution - parent suite's afterAll runs after all nested tests)
        suiteTestIndices.push(...nestedTestIndices);
      }

      // Add suite info (for beforeAll/afterAll execution)
      // Include suite if it has hooks OR if it has tests (direct or nested)
      if (suite.beforeAll.length > 0 || suite.afterAll.length > 0 || suiteTestIndices.length > 0) {
        result.suites.push({
          suitePath: suite.suitePath,
          beforeAll: suite.beforeAll,
          afterAll: suite.afterAll,
          testIndices: suiteTestIndices,
          suiteVariables: suiteVariables  // Include suite variables (from all parent suites)
        });
      }

      return suiteTestIndices;
    };

    // Add file-level tests
    for (const test of parsed.tests) {
      result.tests.push({
        test: test,
        suitePath: [],
        suiteBeforeEachHooks: [],
        suiteAfterEachHooks: [],
        suiteVariables: []  // No suite variables for file-level tests
      });
      testIndex++;
    }

    // Process all top-level suites
    for (const suite of parsed.suites) {
      collectFromSuite(suite, [], [], []);
    }

    return result;
  }

  /**
   * Construct a test script with imports and a single test using AST
   * This is more robust than string interpolation
   * @param originalScript - The full original script (to extract imports)
   * @param testName - The test name
   * @param testBodyCode - The test body code (already extracted)
   * @returns A complete script with imports and the test
   */
  static constructTestScriptWithImports(
    originalScript: string,
    testName: string,
    testBodyCode: string
  ): string {
    try {
      // Parse original script to extract import statements as AST nodes
      const originalAst = parse(originalScript, {
        sourceType: 'module',
        plugins: ['typescript', 'classProperties', 'decorators-legacy'],
        allowImportExportEverywhere: true
      });

      // Collect import declarations
      const importDeclarations: t.ImportDeclaration[] = [];
      traverse(originalAst, {
        ImportDeclaration(path: any) {
          importDeclarations.push(path.node);
        }
      });

      // Parse the test body code to get it as an AST node
      // The test body is a block statement, so we need to parse it
      let testBody: t.BlockStatement;
      try {
        // Try parsing as a block statement
        const bodyAst = parse(`{ ${testBodyCode} }`, {
          sourceType: 'module',
          plugins: ['typescript', 'classProperties', 'decorators-legacy'],
          allowReturnOutsideFunction: true
        });
        
        // Extract the block statement from the parsed code
        if (bodyAst.program.body.length > 0 && t.isBlockStatement(bodyAst.program.body[0])) {
          testBody = bodyAst.program.body[0] as t.BlockStatement;
        } else {
          // Fallback: create a block with the statements
          const statements = bodyAst.program.body.filter(stmt => !t.isImportDeclaration(stmt));
          testBody = t.blockStatement(statements as t.Statement[]);
        }
      } catch (parseError) {
        // If parsing fails, try parsing as statements
        const bodyAst = parse(testBodyCode, {
          sourceType: 'module',
          plugins: ['typescript', 'classProperties', 'decorators-legacy'],
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true
        });
        const statements = bodyAst.program.body.filter(stmt => !t.isImportDeclaration(stmt));
        testBody = t.blockStatement(statements as t.Statement[]);
      }

      // Create the test call expression
      // test('testName', async ({ page, browser, context }) => { ... })
      const testIdentifier = t.identifier('test');
      const testNameLiteral = t.stringLiteral(testName);
      
      // Create async arrow function with parameters
      const pageParam = t.objectPattern([
        t.objectProperty(t.identifier('page'), t.identifier('page'), false, true),
        t.objectProperty(t.identifier('browser'), t.identifier('browser'), false, true),
        t.objectProperty(t.identifier('context'), t.identifier('context'), false, true)
      ]);
      const asyncArrowFunction = t.arrowFunctionExpression(
        [pageParam],
        testBody,
        true // async
      );

      // Create the test() call
      const testCall = t.callExpression(testIdentifier, [
        testNameLiteral,
        asyncArrowFunction
      ]);

      // Variables are already in shared context, so we don't need to include them in script
      const newProgram = t.program([
        ...importDeclarations,
        t.expressionStatement(testCall)
      ]);

      // Generate code from AST
      const output = generate(newProgram, {
        retainLines: false,
        compact: false
      });

      return output.code;
    } catch (error) {
      // Fallback to string interpolation if AST construction fails
      const importStatements = originalScript.match(/import\s+.*?from\s+['"]([^'"]+)['"];?/g) || [];
      const importsCode = importStatements.length > 0 
        ? importStatements.join('\n') + '\n\n'
        : '';
      // Escape test name properly for fallback
      const escapedName = testName.replace(/'/g, "\\'").replace(/\n/g, '\\n');
      return `${importsCode}test('${escapedName}', async ({ page, browser, context }) => {\n${testBodyCode}\n});`;
    }
  }

  /**
   * Construct a script with imports from the original script + suite variables + hook code
   * This ensures hooks can access imported classes/functions (e.g., SignInPage) and suite-level variables
   */
  static constructHookScriptWithImports(
    originalScript: string,
    hookCode: string
  ): string {
    try {
      // Parse original script to extract import statements
      const originalAst = parse(originalScript, {
        sourceType: 'module',
        plugins: ['typescript', 'classProperties', 'decorators-legacy'],
        allowImportExportEverywhere: true
      });

      // Collect import declarations
      const importDeclarations: t.ImportDeclaration[] = [];
      traverse(originalAst, {
        ImportDeclaration(path: any) {
          importDeclarations.push(path.node);
        }
      });

      // Generate import statements as code
      const importStatements = importDeclarations.map(imp => generate(imp).code);

      // Combine imports + hook code
      // Variables are already in shared context, so we don't need to include them in script
      const importsCode = importStatements.length > 0 
        ? importStatements.join('\n') + '\n\n'
        : '';
      
      return `${importsCode}${hookCode}`;
    } catch (error) {
      // Fallback: just return hook code if parsing fails
      return hookCode;
    }
  }

  /**
   * Extract test body code from a repaired script
   * The repaired script contains imports + a single test, we need just the test body
   * @param script - The repaired script (with imports and test)
   * @returns The test body code (function body) or null if not found
   */
  static extractTestBodyFromScript(script: string): string | null {
    try {
      const ast = parse(script, {
        sourceType: 'module',
        plugins: ['typescript', 'classProperties', 'decorators-legacy'],
        allowImportExportEverywhere: true
      });

      let testBody: string | null = null;
      let found = false;

      traverse(ast, {
        CallExpression(path: any) {
          if (found) {
            path.stop(); // Stop traversal once we've found the test
            return;
          }
          
          const callee = path.node.callee;
          if (isTestCall(callee)) {
            if (path.node.arguments.length >= 2) {
              const testNameArg = path.node.arguments[0];
              const testCallback = path.node.arguments[1];
              
              let testName: string | null = null;
              if (t.isStringLiteral(testNameArg)) {
                testName = testNameArg.value;
              } else if (t.isTemplateLiteral(testNameArg)) {
                if (testNameArg.quasis.length > 0) {
                  testName = testNameArg.quasis[0].value.raw;
                }
              }
              
              // For single-test scripts, we can extract the body regardless of name match
              // (the script should only contain one test in repair mode)
              if (testName && testCallback) {
                if (t.isFunctionExpression(testCallback) || t.isArrowFunctionExpression(testCallback)) {
                  // Extract body code from original script string to preserve comments (including annotations)
                  // Use AST positions to slice the script string directly, preserving all formatting and comments
                  if (t.isBlockStatement(testCallback.body)) {
                    const bodyStart = testCallback.body.start;
                    const bodyEnd = testCallback.body.end;
                    if (bodyStart != null && bodyEnd != null) {
                      // Slice the body including braces to preserve exact formatting and comments
                      // This preserves annotations that were added as comments
                      testBody = script.slice(bodyStart, bodyEnd);
                    } else {
                      // Fallback to generation with comments preserved if positions are missing
                      testBody = generate(testCallback.body, { comments: true }).code;
                    }
                  } else {
                    // Expression body - wrap in braces and preserve comments
                    const exprCode = generate(testCallback.body, { comments: true }).code;
                    testBody = `{ return ${exprCode}; }`;
                  }
                  found = true;
                  path.stop(); // Stop traversal after finding the first test
                }
              }
            }
          }
        }
      });

      return testBody;
    } catch (error) {
      return null;
    }
  }

  /**
   * Reconstruct the full test file with repairs applied to specific tests
   * Preserves all structure (imports, hooks, suites, file variables, unrepaired tests)
   * @param originalScript - The original test file content
   * @param parsed - The parsed test file structure
   * @param testRepairs - Map of TestPathway (JSON stringified) -> repaired test body code
   * @returns The reconstructed test file with repairs applied
   */
  static reconstructTestFileWithRepairs(
    originalScript: string,
    parsed: ParsedTestFile,
    testRepairs: Map<string, string>
  ): string {
    if (testRepairs.size === 0) {
      return originalScript; // No repairs, return original
    }

    try {
      // Parse original script
      const ast = parse(originalScript, {
        sourceType: 'module',
        plugins: ['typescript', 'classProperties', 'decorators-legacy'],
        allowImportExportEverywhere: true
      });

      // Traverse AST and replace repaired test bodies
      traverse(ast, {
        CallExpression(path: any) {
          const callee = path.node.callee;
          
          // Check if this is a test() call
          if (isTestCall(callee)) {
            if (path.node.arguments.length >= 2) {
              const testNameArg = path.node.arguments[0];
              const testCallback = path.node.arguments[1];
              
              // Extract test name
              let testName: string | null = null;
              if (t.isStringLiteral(testNameArg)) {
                testName = testNameArg.value;
              } else if (t.isTemplateLiteral(testNameArg)) {
                if (testNameArg.quasis.length > 0) {
                  testName = testNameArg.quasis[0].value.raw;
                }
              }
              
              if (testName) {
                // Find suite path for this test
                const suitePath = TestFileParser.findSuitePath(path);
                // Create TestPathway key (JSON stringified for Map lookup)
                const testPathwayKey = JSON.stringify({
                  suitePath: suitePath || [],
                  testName: testName.trim()
                });
                
                // Check if this test was repaired
                const repairedBody = testRepairs.get(testPathwayKey);
                if (repairedBody && (t.isFunctionExpression(testCallback) || t.isArrowFunctionExpression(testCallback))) {
                  // Parse the repaired body code
                  // The body code is a BlockStatement like "{ ... }" - wrap it in a function to parse it correctly
                  // This preserves comments and annotations that were added
                  try {
                    // Wrap the body in a function expression to make it parseable
                    // The body already includes braces, so we wrap it directly
                    const wrappedCode = `async ({ page }) => ${repairedBody}`;
                    const wrappedAst = parse(wrappedCode, {
                      sourceType: 'module',
                      plugins: ['typescript', 'classProperties', 'decorators-legacy'],
                      allowReturnOutsideFunction: true,
                      allowAwaitOutsideFunction: true
                    });
                    
                    // Extract body from the wrapped function
                    let newBody: t.BlockStatement | null = null;
                    
                    traverse(wrappedAst, {
                      ArrowFunctionExpression(path: any) {
                        if (newBody) return;
                        if (t.isBlockStatement(path.node.body)) {
                          newBody = path.node.body;
                          path.stop();
                        }
                      },
                      FunctionExpression(path: any) {
                        if (newBody) return;
                        if (t.isBlockStatement(path.node.body)) {
                          newBody = path.node.body;
                          path.stop();
                        }
                      }
                    });
                    
                    if (!newBody) {
                      // Fallback: try parsing as program (for backwards compatibility with old format)
                      const repairedAst = parse(repairedBody, {
                        sourceType: 'module',
                        plugins: ['typescript', 'classProperties', 'decorators-legacy'],
                        allowReturnOutsideFunction: true,
                        allowAwaitOutsideFunction: true
                      });
                      
                      if (repairedAst.program.body.length > 0 && t.isBlockStatement(repairedAst.program.body[0])) {
                        newBody = repairedAst.program.body[0] as t.BlockStatement;
                      } else {
                        // Wrap statements in block
                        const statements = repairedAst.program.body.filter(stmt => !t.isImportDeclaration(stmt));
                        if (statements.length === 0) {
                          // Empty body - create empty block
                          newBody = t.blockStatement([]);
                        } else {
                          newBody = t.blockStatement(statements as t.Statement[]);
                        }
                      }
                    }
                    
                    // Replace the test callback body
                    if (t.isFunctionExpression(testCallback)) {
                      testCallback.body = newBody;
                    } else if (t.isArrowFunctionExpression(testCallback)) {
                      // For arrow functions, we need to replace the entire callback
                      const newCallback = t.arrowFunctionExpression(
                        testCallback.params,
                        newBody,
                        testCallback.async
                      );
                      path.node.arguments[1] = newCallback;
                    }
                  } catch (parseError) {
                    // If parsing fails, log and skip this repair
                    console.warn(`Failed to parse repaired body for test ${testPathwayKey}:`, parseError);
                  }
                }
              }
            }
          }
        }
      });

      // Generate updated code
      const output = generate(ast, {
        retainLines: false,
        compact: false
      });

      return output.code;
    } catch (error) {
      // If reconstruction fails, return original script
      console.error('Failed to reconstruct test file with repairs:', error);
      return originalScript;
    }
  }
}

