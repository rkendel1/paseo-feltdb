import { describe, expect, it } from "vitest";
import { matchWorkspaceQuery } from "./workspace-search";

describe("matchWorkspaceQuery", () => {
  const workspace = {
    searchText: "payments refactor · primary host · feature/checkout",
    changeRequestNumber: 42,
  };

  it("matches everything when the query is empty", () => {
    expect(matchWorkspaceQuery(workspace, "  ")).toEqual({
      matches: true,
      changeRequestHit: false,
    });
  });

  it("matches its own change-request number in every spelling and flags the hit", () => {
    const spellings = ["42", " 42 ", "#42", "!42", "pr 42", "mr 42", "PR #42", "mr!42", "pr42"];
    for (const query of spellings) {
      expect(matchWorkspaceQuery(workspace, query)).toEqual({
        matches: true,
        changeRequestHit: true,
      });
    }
  });

  it("does not take the number path for text that merely contains digits", () => {
    // Without this, `fix-42-retries` would jump to PR 42.
    const numbered = { searchText: "unrelated workspace", changeRequestNumber: 42 };
    for (const query of ["fix-42-retries", "42x", "v4.2", "pr"]) {
      expect(matchWorkspaceQuery(numbered, query)).toEqual({
        matches: false,
        changeRequestHit: false,
      });
    }
  });

  it("does not match a different change-request number that shares digits", () => {
    const other = { searchText: "unrelated workspace", changeRequestNumber: 142 };
    expect(matchWorkspaceQuery(other, "42")).toEqual({ matches: false, changeRequestHit: false });
  });

  it("still matches on title and branch text", () => {
    expect(matchWorkspaceQuery(workspace, "checkout")).toEqual({
      matches: true,
      changeRequestHit: false,
    });
    expect(matchWorkspaceQuery(workspace, "payments")).toEqual({
      matches: true,
      changeRequestHit: false,
    });
  });

  it("leaves a workspace without a change request unaffected", () => {
    const noPr = { searchText: "docs workspace", changeRequestNumber: null };
    expect(matchWorkspaceQuery(noPr, "42")).toEqual({ matches: false, changeRequestHit: false });
    expect(matchWorkspaceQuery(noPr, "docs")).toEqual({ matches: true, changeRequestHit: false });
  });

  it("falls back to text matching when the number does not match", () => {
    // "42" appears in the text but the PR is 7 — a text hit, not a change-request hit.
    const textual = { searchText: "branch fix-42-retries", changeRequestNumber: 7 };
    expect(matchWorkspaceQuery(textual, "42")).toEqual({ matches: true, changeRequestHit: false });
  });
});
