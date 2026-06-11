# Me My Money

这是一个按个人长期美股策略定制的持仓推荐工作台。它不再每天只推荐一只股票，而是按“AI核心趋势仓 / 高弹性进攻仓 / 超短线交易仓 / 机动现金”的资金结构，结合实时价格、持仓偏离、买卖窗口、止损点和来源优先级生成组合结论。

## 直接部署到 GitHub Pages

把整个文件夹上传到 GitHub 仓库根目录，然后在仓库里打开：

1. `Settings`
2. `Pages`
3. `Build and deployment`
4. Source 选择 `Deploy from a branch`
5. Branch 选择 `main`，目录选择 `/root`
6. 保存后等待 GitHub 生成网址

GitHub Pages 会直接加载根目录的 `index.html`。账户设置、持仓与交易记录会保存在当前浏览器的 `localStorage`。

## 数据更新

页面读取数据的优先级是：

1. 本地 Node 实时 API：`/api/dashboard`
2. GitHub Action 每日快照：`data/market-snapshot.json`
3. 内置示例数据兜底

已内置 `.github/workflows/daily-market-snapshot.yml`，会在工作日自动运行，也可以手动触发。建议在仓库 `Secrets and variables` 里配置：

- `TWELVE_DATA_API_KEY`
- `ALPHA_VANTAGE_API_KEY`
- `X_BEARER_TOKEN`
- `SERENITY_X_ACCOUNT`
- `X_ACCOUNTS`
- `YOUTUBE_API_KEY`
- `YOUTUBE_QUERIES`

Serenity 的 X 信号会被置顶并加权。如果 Serenity 的准确 handle 不是 `Serenity`，把 `SERENITY_X_ACCOUNT` 改成正确账号即可。

## 本地 Node 版

复制 `.env.example` 为 `.env`，按需填入密钥，然后运行：

```bash
npm run dev
```

打开：

```text
http://localhost:5177
```

Node 版会保存持仓、执行记录和账户数据到 `data/state.json`，并支持删除误添加的持仓或执行记录。外部数据请求都有短超时和样本兜底，避免一个来源异常拖慢整个页面。
