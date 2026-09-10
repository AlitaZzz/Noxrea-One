import { describe, expect, it } from "vitest";

import { sanitizeFileName } from "@/lib/utils/file-name";

describe("sanitizeFileName", () => {
  it("正常文件名保持不变", () => {
    expect(sanitizeFileName("photo.jpg")).toBe("photo.jpg");
    expect(sanitizeFileName("我的封面 2026.png")).toBe("我的封面 2026.png");
  });

  it("替换 Windows / macOS 非法字符", () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("去掉控制字符", () => {
    const name = `a${String.fromCharCode(0, 9, 10, 31, 127)}b`;
    expect(sanitizeFileName(name)).toBe("ab");
  });

  it("折叠空白并去掉首尾的点与空格", () => {
    expect(sanitizeFileName("  a  \n b  ")).toBe("a b");
    expect(sanitizeFileName("  名字.  ")).toBe("名字");
  });

  it("规避 Windows 保留设备名", () => {
    expect(sanitizeFileName("CON")).toBe("CON_");
    expect(sanitizeFileName("con.txt")).toBe("con_.txt");
    expect(sanitizeFileName("CONSOLE")).toBe("CONSOLE");
  });

  it("超长时截断主干并保留扩展名", () => {
    const out = sanitizeFileName(`${"a".repeat(200)}.png`);
    expect(out).toHaveLength(120);
    expect(out.endsWith(".png")).toBe(true);
    expect(sanitizeFileName("a".repeat(200))).toHaveLength(120);
  });

  it("扩展名过长时不认作扩展名，整体截断到上限", () => {
    const out = sanitizeFileName(`a.${"b".repeat(200)}`);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  it("空入参与全是控制字符时返回空串", () => {
    expect(sanitizeFileName("")).toBe("");
    expect(sanitizeFileName(String.fromCharCode(0, 31, 127))).toBe("");
  });
});
