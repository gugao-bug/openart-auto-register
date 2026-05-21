# OpenArt 批量注册工具

基于 **Roxy 指纹浏览器** + **Cloudflare 临时邮箱** 的 OpenArt 全自动批量注册工具。

每账号获得 **20,000 Credits**（通过 Affiliate 邀请链接）。

## 环境要求

- Node.js >= 18
- [Roxy 浏览器](https://roxybrowser.cn/) 已登录并开启 API
- Cloudflare 临时邮箱 API 服务

## 部署步骤

### 1. 安装依赖

```bash
npm install
npx playwright install chromium
```

### 2. 配置 Roxy 浏览器

1. 打开 Roxy 浏览器 → 左侧菜单 → **API** → **API配置**
2. 开启 API 开关
3. 复制 **API Key** (Token)
4. 记录端口号（默认 `50000`）

### 3. 填写 config.json

```json
{
  "mail": {
    "apiBase": "你的邮箱API地址",
    "adminPassword": "管理员密码",
    "domains": ["域名1.bond", "域名2.bond"]
  },
  "roxy": {
    "apiBase": "http://127.0.0.1:50000",
    "token": "你的Roxy_Token",
    "workspaceId": 你的工作空间ID
  },
  "register": {
    "affiliateCode": "YT Affiliate",
    "count": 10,
    "concurrency": 3,
    "headless": false,
    "turnstileTimeout": 120
  }
}
```

| 参数 | 说明 |
|------|------|
| `mail.apiBase` | Cloudflare 临时邮箱 API 地址 |
| `mail.adminPassword` | 邮箱管理员密码 |
| `mail.domains` | 可用域名列表，轮询使用 |
| `roxy.token` | Roxy 浏览器 API Token |
| `roxy.workspaceId` | 工作空间 ID（可通过 `/browser/workspace` 接口获取） |
| `register.count` | 注册数量 |
| `register.concurrency` | 并行数（建议 2-5） |
| `register.headless` | 是否无头模式（false 可手动处理 Turnstile） |

### 4. 获取 workspaceId

打开 Roxy 浏览器后运行：

```bash
curl -s http://127.0.0.1:50000/browser/workspace -H "token: 你的Token"
```

## 运行

```bash
npm start
# 或双击 启动.bat
# 或 node batch_register_roxy.js
```

## 工作流程

1. 通过 Roxy API 创建独立指纹的浏览器窗口
2. Playwright CDP 连接窗口自动填表
3. Cloudflare Turnstile 验证（需手动点击 / 自动处理）
4. Clerk 邮箱验证码自动读取并填入
5. 注册成功后自动领取 20,000 Credits
6. 关闭并清理浏览器窗口
7. 账号密码批量导出到 `accounts_*.json` 和 `accounts_*.txt`

## 输出文件

- `accounts_*.json` — 完整账号数据
- `accounts_*.txt` — 纯文本格式 `邮箱----密码`
