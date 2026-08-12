import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Adds an inline review comment to a visible diff row.
 *
 * The gutter "+" button only renders while the row is hovered, so the hover is part of the
 * contract here, not incidental. `row` is the `diff-code-row-<n>` locator of the line to comment
 * on; the matching gutter action carries the same index.
 */
export async function addInlineReviewComment(
  page: Page,
  input: { root?: Locator; rowIndex: number; body: string },
): Promise<void> {
  const root = input.root ?? page.locator("body");
  await root.getByTestId(`diff-code-row-${input.rowIndex}`).hover();
  await root.getByTestId(`diff-gutter-action-${input.rowIndex}`).click();

  const editor = page.getByTestId("inline-review-editor").filter({ visible: true });
  await expect(editor).toBeVisible();
  await editor.getByTestId("inline-review-editor-input").fill(input.body);
  await editor.getByTestId("inline-review-editor-save").click();
  await expect(editor).toHaveCount(0);
}
