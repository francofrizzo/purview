import { it, expect } from "vitest";
import { outdatedCommentTip, isCommentAnchored } from "./comments";
import type { DraftComment, FilesJson } from "../api/types";
it("maps outdated metadata to the chip tooltip and outside-diff treatment", () => {
 const comment: DraftComment = { id:"old", revision:2, file:"a", line:3, side:"RIGHT", body:"x", outdated:{line:3,revision:1} };
 expect(outdatedCommentTip(comment)).toBe("Written on rev 1 at line 3; that line is no longer in the diff");
 expect(outdatedCommentTip({})).toBeUndefined();
 expect(isCommentAnchored({files:[]} as unknown as FilesJson,comment)).toBe(false);
});
