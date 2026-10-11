// @vitest-environment jsdom
/**
 * focus-ring 工具回归测试：
 * 指针模态下关闭浮层时给触发器打抑制标记，键盘模态不打；
 * 标记在焦点离开或下一次任意输入时自动清除。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  getLastInputModality,
  registerFocusRingAnchor,
  suppressFocusRingForContent,
} from "@/lib/focus-ring";

function pressKey(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
}

function pointerDown(): void {
  window.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
}

describe("focus-ring", () => {
  let content: HTMLDivElement;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    trigger = document.createElement("button");
    content = document.createElement("div");
    document.body.append(trigger, content);
    // 回到键盘模态（模块级状态在同一文件内跨用例保留）
    pressKey();
  });


  // 文件内首个用例：此刻模块尚未收到任何输入事件，断言的是真实初始默认值
  it("defaults to keyboard modality before any input", () => {
    expect(getLastInputModality()).toBe("keyboard");
  });

  it("tracks pointer input", () => {
    pointerDown();
    expect(getLastInputModality()).toBe("pointer");
    pressKey();
    expect(getLastInputModality()).toBe("keyboard");
  });

  it("resolves the trigger via aria-labelledby (DropdownMenu)", () => {
    content.id = "menu-content";
    content.setAttribute("aria-labelledby", "zoom-trigger");
    trigger.id = "zoom-trigger";
    registerFocusRingAnchor(content);
    pointerDown();
    suppressFocusRingForContent(content);
    expect(trigger.hasAttribute("data-focus-ring-suppressed")).toBe(true);
  });

  it("does not suppress under keyboard modality", () => {
    content.id = "menu-content";
    content.setAttribute("aria-labelledby", "zoom-trigger");
    trigger.id = "zoom-trigger";
    registerFocusRingAnchor(content);
    suppressFocusRingForContent(content);
    expect(trigger.hasAttribute("data-focus-ring-suppressed")).toBe(false);
  });

  it("clears the suppression on next input", () => {
    content.id = "menu-content";
    content.setAttribute("aria-labelledby", "zoom-trigger");
    trigger.id = "zoom-trigger";
    registerFocusRingAnchor(content);
    pointerDown();
    suppressFocusRingForContent(content);
    expect(trigger.hasAttribute("data-focus-ring-suppressed")).toBe(true);
    // 下一次键盘输入即清除（焦点环语义交还浏览器）
    pressKey();
    expect(trigger.hasAttribute("data-focus-ring-suppressed")).toBe(false);
  });

  it("clears the suppression when focus leaves the trigger", () => {
    content.id = "menu-content";
    content.setAttribute("aria-labelledby", "zoom-trigger");
    trigger.id = "zoom-trigger";
    registerFocusRingAnchor(content);
    pointerDown();
    suppressFocusRingForContent(content);
    expect(trigger.hasAttribute("data-focus-ring-suppressed")).toBe(true);
    trigger.dispatchEvent(new FocusEvent("focusout"));
    expect(trigger.hasAttribute("data-focus-ring-suppressed")).toBe(false);
  });

  it("resolves the trigger via aria-controls (Popover)", () => {
    content.id = "popover-content";
    trigger.setAttribute("aria-controls", "popover-content");
    pointerDown();
    registerFocusRingAnchor(content);
    suppressFocusRingForContent(content);
    expect(trigger.hasAttribute("data-focus-ring-suppressed")).toBe(true);
    pointerDown();
    expect(trigger.hasAttribute("data-focus-ring-suppressed")).toBe(false);
  });

  it("does nothing without a registered anchor", () => {
    content.id = "unregistered-content";
    pointerDown();
    suppressFocusRingForContent(content);
    expect(document.querySelectorAll("[data-focus-ring-suppressed]")).toHaveLength(0);
  });

});
