import { describe, expect, it } from "vitest";
import { ISSUES_VIEW_STATE_KEY } from "./issues-view-state";

describe("ISSUES_VIEW_STATE_KEY", () => {
  it("uses the bumped key so stale closed-only filters are ignored", () => {
    expect(ISSUES_VIEW_STATE_KEY).toBe("paperclip:issues-view:v2");
  });
});
