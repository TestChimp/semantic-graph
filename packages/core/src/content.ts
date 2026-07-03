import { createHash } from 'crypto';
import type { ParsedTest, ParsedTestFile, ParsedSuite } from './test-file-parser';
import { TestFileParser } from './test-file-parser';

export function flattenParsedTests(parsed: ParsedTestFile): ParsedTest[] {
  const tests: ParsedTest[] = [...parsed.tests];
  function walk(suite: ParsedSuite) {
    tests.push(...suite.tests);
    for (const nested of suite.nestedSuites) walk(nested);
  }
  for (const suite of parsed.suites) walk(suite);
  return tests;
}

function formatSuitePath(suitePath?: string[]): string {
  if (!suitePath?.length) return '';
  return suitePath.join(' > ');
}

function statementLines(test: ParsedTest): string[] {
  const lines: string[] = [];
  for (const st of test.statements) {
    if (st.scenarioAnnotationOnly) continue;
    if (st.scenarioAnnotation) {
      lines.push(`Scenario: ${st.scenarioAnnotation}`);
      continue;
    }
    if (st.intentComment) {
      lines.push(`// intent: ${st.intentComment}`);
    }
    if (st.code?.trim()) {
      lines.push(st.code.trim());
    }
  }
  return lines;
}

/** Build canonical embedding text for a single test (body only, no shared context). */
export function buildEmbeddingText(test: ParsedTest): string {
  const parts: string[] = [];
  const suite = formatSuitePath(test.suitePath);
  if (suite) parts.push(`Suite: ${suite}`);
  parts.push(`Test: ${test.name}`);
  const body = statementLines(test);
  if (body.length) {
    parts.push('Body:');
    parts.push(...body);
  } else if (test.code?.trim()) {
    parts.push('Body:');
    parts.push(test.code.trim());
  }
  return parts.join('\n');
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface FileTestEmbeddingDraft {
  testName: string;
  suitePath: string[];
  title: string;
  content: string;
  contentHash: string;
}

/** Parse file once and produce embedding drafts for all tests. */
export function extractEmbeddingDraftsFromFile(
  fileContent: string,
  displayTitleFn?: (test: ParsedTest) => string,
): { drafts: FileTestEmbeddingDraft[]; parseError?: string } {
  let parsed: ParsedTestFile;
  try {
    parsed = TestFileParser.parseTestFile(fileContent);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { drafts: [], parseError: msg };
  }
  const tests = flattenParsedTests(parsed);
  const drafts = tests.map((test) => {
    const content = buildEmbeddingText(test);
    return {
      testName: test.name,
      suitePath: test.suitePath ?? [],
      title: displayTitleFn ? displayTitleFn(test) : test.name,
      content,
      contentHash: hashContent(content),
    };
  });
  return { drafts };
}
