import { describe, expect, it } from "vitest";
import { matchWorkspaceQuery, parseChangeRequestQuery } from "./workspace-search";

describe("parseChangeRequestQuery", () => {
  it("accepts a bare number", () => {
    expect(parseChangeRequestQuery("42")).toBe(42);
  });

  it("accepts every forge prefix and noun spelling", () => {
    for (const query of ["#42", "!42", "pr 42", "mr 42", "PR #42", "mr!42", "pr42", " 42 "]) {
      expect(parseChangeRequestQuery(query)).toBe(42);
    }
  });

  it("rejects text that merely contains digits", () => {
    for (const query of ["fix-42-retries", "42x", "v4.2", "", "pr"]) {
      expect(parseChangeRequestQuery(query)).toBeNull();
    }
  });
});

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

  it("matches its own change-request number and flags the hit", () => {
    for (const query of ["42", "#42", "!42", "pr 42", "mr 42"]) {
      expect(matchWorkspaceQuery(workspace, query)).toEqual({
        matches: true,
        changeRequestHit: true,
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
