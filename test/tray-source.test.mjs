import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = () => readFileSync("native/CodexZhTray.cs", "utf8");

test("Windows 托盘退出会先停用远程 daemon", () => {
  assert.match(
    source(),
    /void DoQuit\(\)[\s\S]*Backend\.Call\("disable"\)[\s\S]*ExitThread\(\)/,
  );
});

test("Windows 托盘菜单提供单独启动远程且菜单项不带省略号", () => {
  const text = source();
  assert.match(text, /AddItem\(m, "启动远程", \(s, e\) => DoEnable\(\)\)/);
  assert.doesNotMatch(text, /AddItem\(m, "[^"]*…"/);
});

test("Windows 托盘声明 DPI aware 并使用 UI 字体", () => {
  const text = source();
  assert.match(text, /SetProcessDPIAware\(\)/);
  assert.match(text, /AutoScaleMode = AutoScaleMode\.Dpi/);
  assert.match(text, /new Font\("Microsoft YaHei UI"/);
});

test("Windows 托盘窗口留出 DPI 后的内容空间", () => {
  const text = source();
  assert.match(text, /MakeWindow\("微信扫码 · 配对C叉叉", 480, 700\)/);
  assert.match(text, /MakeWindow\("已配对设备", 480, 500\)/);
  assert.match(text, /MakeWindow\("通知设置", 480, 480\)/);
  assert.match(text, /Text = "复制配对链接"/);
  assert.doesNotMatch(text, /MiddleTruncate\(LinkForDisplay\(url\), 44\)/);
});
