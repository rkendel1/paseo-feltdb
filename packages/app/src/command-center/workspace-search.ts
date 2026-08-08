/**
 * Query matching for command center workspace results.
 *
 * Workspaces match on their text (title, host, project, branch) the same way
 * everything else in the palette does, plus a dedicated change-request path so
 * you can jump to a workspace by its PR/MR number.
 *
 * The number path deliberately does NOT go through the substring matcher.
 * Substring matching gets both halves wrong: `pr 42` is not a substring of
 * `PR #42`, and a GitHub token (`#42`) would never match a GitLab query
 * (`!42`) — while a bare `42` would match PR 142, PR 420, and any branch that
 * happens to contain "42". Parsing the query into a number and comparing it
 * exactly fixes both.
 */

/** A change-request query: an optional `pr`/`mr` word, an optional `#`/`!`, a number. */
const CHANGE_REQUEST_QUERY = /^(?:(?:pr|mr)\s*)?[#!]?(\d+)$/i;

/**
 * Parse a change-request-shaped query into its number.
 *
 * Accepts `42`, `#42`, `!42`, `pr 42`, `pr42`, `PR #42`, `mr!42`, and so on.
 * Returns null for anything else, including text queries that merely contain
 * digits (`fix-42-retries`), so those fall through to normal text matching.
 */
export function parseChangeRequestQuery(query: string): number | null {
  const match = CHANGE_REQUEST_QUERY.exec(query.trim());
  if (!match) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(number) ? number : null;
}

export interface WorkspaceSearchCandidate {
  /** Lowercased title + subtitle, matched as a substring. */
  searchText: string;
  /** The workspace's PR/MR number, when it has one. */
  changeRequestNumber?: number | null;
}

export interface WorkspaceSearchMatch {
  matches: boolean;
  /** True when the query is a change-request number that this workspace owns. */
  changeRequestHit: boolean;
}

const NO_MATCH: WorkspaceSearchMatch = { matches: false, changeRequestHit: false };
const TEXT_MATCH: WorkspaceSearchMatch = { matches: true, changeRequestHit: false };
const CHANGE_REQUEST_MATCH: WorkspaceSearchMatch = { matches: true, changeRequestHit: true };

/**
 * Match a workspace against a query.
 *
 * `changeRequestHit` is reported separately so callers can rank exact
 * number matches above incidental text matches for the same query.
 */
export function matchWorkspaceQuery(
  candidate: WorkspaceSearchCandidate,
  query: string,
): WorkspaceSearchMatch {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return TEXT_MATCH;

  const requestedNumber = parseChangeRequestQuery(normalized);
  if (requestedNumber !== null && candidate.changeRequestNumber === requestedNumber) {
    return CHANGE_REQUEST_MATCH;
  }
  return candidate.searchText.includes(normalized) ? TEXT_MATCH : NO_MATCH;
}
