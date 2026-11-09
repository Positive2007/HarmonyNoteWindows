# 云记事 · Windows 端

云记事是一款本地优先的笔记应用，手机端是鸿蒙原生 App，本仓库是配套的 Windows 桌面端。
两端在**同一局域网**内直接互传笔记文件，不需要服务器、不需要注册账号。

## 功能

- 浏览、新建、编辑文字笔记（支持多页）
- 手写板：鼠标 / 数位笔书写，多页、撤销、适应画面
- 按页查看手机端的手写笔记，自动整页缩放，不会裁切
- 回收站：恢复、彻底删除
- 与鸿蒙端双向同步（TCP 8787），手机端改完电脑能看到，电脑改完手机同步时取回

## 安装使用

1. 从 Releases 下载 `云记事_x.y.z_x64-setup.exe`
2. 双击安装（会请求管理员权限，用于写入 Program Files 并放行防火墙）
3. 安装完成后从开始菜单或桌面快捷方式启动

安装程序会自动添加 Windows 防火墙入站规则（TCP 8787，`profile=any`），
**不需要手动运行任何 .bat**。卸载时会自动删除该规则。

如果使用绿色版 exe（未安装），首次启动会弹窗询问是否放行防火墙，
点「确定」后在系统 UAC 弹窗里选择「是」即可；也可以随时点界面左下角的
「🛡️ 防火墙放行」重试。

## 从源码构建

### 环境

- Windows 10 LTSC 2021 及以上
- [Rust](https://rustup.rs)（MSVC 工具链）
- Visual Studio Build Tools 2022，勾选「使用 C++ 的桌面开发」
- Node.js 18+
- WebView2 Runtime（Win10 LTSC 2021 通常自带）

### 构建

```bat
npm install -D @tauri-apps/cli@latest
npx tauri build
```

产物：

- 安装包：`src-tauri\target\release\bundle\nsis\云记事_1.0.0_x64-setup.exe`
- 绿色版：`src-tauri\target\release\harmonynote-windows.exe`

开发调试：

```bat
npx tauri dev
```

## 数据位置

笔记保存在 `%APPDATA%\com.harmonynote.desktop\notes\`，每条笔记是一个 `.json`，
手写笔迹是对应的 `.ink` 文件（JSON 格式的矢量笔画）。界面里有「打开笔记目录」按钮。

> 该目录名沿用了旧标识，**不要随意修改 `identifier`**，否则已有笔记会“消失”（实际是换了目录）。

## 与手机端的约定

| 项目 | 值 |
|---|---|
| 端口 | TCP 8787 |
| 发现方式 | mDNS `_harmonynote._tcp`，服务名带本机 IPv4 |
| 接口 | `GET /api/ping`、`GET /api/notes`、`GET/PUT/DELETE /api/files/:name` |
| 冲突 | 版本号高者胜；PUT 版本低于现有文件时返回 409，避免旧副本覆盖新内容 |

手机端发现不到电脑时，可在手机 App 里手动填写电脑界面左上角显示的 `IP:8787`。

## 代码结构

```
ui/                前端（原生 HTML/CSS/JS，无打包步骤）
  index.html
  app.js
  style.css
src-tauri/
  src/main.rs      HTTP 服务、mDNS 广播、笔记文件读写、防火墙命令
  nsis/installer-hooks.nsh   安装/卸载时自动放行/移除防火墙规则
  tauri.conf.json
```

## 常见问题

**手机提示连不上 / 同步 0 条**
先看电脑端界面左上角是否显示 `IP:8787`、`sync-line` 是否显示手机连接过。
确认手机与电脑在同一 Wi-Fi（或手机热点下电脑已连入），并检查防火墙规则
`CloudNote-LAN-8787` 是否存在。

**手机发现不到电脑（但同一网络）**
部分路由器/AP 开启了客户端隔离或屏蔽组播，mDNS 会失效。
此时在手机 App 里点「用 IP 同步」，填入电脑界面显示的 `IP:8787` 即可，地址会记住。

**端口被占用**
界面会显示「端口 8787 被占用」。关闭占用该端口的程序后重启本应用。

**SmartScreen 提示“未知发布者”**
未购买代码签名证书时会出现，点「更多信息 → 仍要运行」即可。
