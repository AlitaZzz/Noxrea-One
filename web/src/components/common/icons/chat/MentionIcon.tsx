/**
 * 提及音频引用的波形图标，用于拼接到 contentEditable 的 HTML 字符串中。
 * 以字符串常量形式导出，供 MentionPrompt 在生成 innerHTML 时内联使用。
 */
export const MentionIconSvg = `<svg viewBox="0 0 16 16" fill="none" style="display:inline-block;vertical-align:-0.125em;width:14px;height:14px;"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M1.333 6.667v2M4 4v7.333M6.667 2v12M9.333 5.333V10M12 3.333V12M14.667 6.667v2"/></svg>`;

export default MentionIconSvg;
