# 参与贡献

感谢关注 MDTurn。当前项目最需要的贡献,按优先级:

1. **Windows 桌面版**——入口清单见 [docs/windows-porting.md](docs/windows-porting.md);
2. Linux 桌面版(同一套 Electron 壳,工作量与 Windows 类似);
3. Bug 报告与修复、文档改进。

## 开发环境

```bash
# Node.js ≥ 20;桌面壳依赖全部精确锁版本
npm --prefix desktop install --cache desktop/.npm-cache
npm --prefix desktop run build:vendor
npm --prefix desktop run dev        # 启动桌面壳(需本地服务在跑,或先 node server.js)
```

## 提交 PR 前的验证

```bash
node --test test/*.test.js          # 服务与存储层测试
npm --prefix desktop test           # 桌面壳测试
node --check server.js && node --check mdshare.js && node --check mdreview.js
```

## 代码约定

- **后端(`server.js`、`lib/`、CLI)只使用 Node 内置模块**,不引入运行时依赖;
- 桌面壳依赖必须精确锁版本(`"x.y.z"`,不带 `^`/`~`),并更新 `desktop/package-lock.json`;
- 新增第三方库须为宽松许可证(MIT/BSD/Apache 类),并在 README「开源许可」一节登记;
- JSON 落盘一律走 `lib/review-store` 的原子写入与校验,不得绕过;
- 安全边界不放松:服务只监听 `127.0.0.1`;`/desktop`、审阅接口和本地文件接口必须
  继续拒绝携带 Cloudflare 头的请求;分享链接必须带 ID + token。
- 界面与文档以中文为主,欢迎补充英文;提交信息中英文皆可。

## 提交方式

- Fork 后从 `main` 拉分支,小步提交,PR 描述里写清动机与验证方式;
- 平台特有改动(如 Windows)请附运行截图与测试结果;
- 行为变化需同步更新 README 或相应文档。
