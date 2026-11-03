export function pageSaveRequest(page, content) {
  return {
    page_key: page.page_key,
    content,
    prompt: page.prompt,
    expected_content_sha256: page.content_sha256,
    expected_prompt_sha256: page.prompt_sha256,
    expected_context_sha256: page.prompt_context_sha256,
    lettering: { items: page.lettering.items },
    expected_layout_sha256: page.layout_sha256,
    expected_layout_items: page.lettering.items,
  };
}
