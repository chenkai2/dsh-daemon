# dsh-daemon — 维护约定

## 发布：只走 GitHub Release，**禁止本地 `npm publish`**

本包的发布链路是 **GitHub Release → GitHub Actions → npm Trusted Publishing（OIDC）**：

```
打 tag vX.Y.Z → 建 GitHub Release → .github/workflows/publish.yml 触发
  → npm publish --provenance（凭 GitHub OIDC 短期令牌，不需要 NPM_TOKEN）
```

**为什么不能本地发**：

1. 本地 `npm publish` 走的是你机器上的 `_authToken`，产出**没有 provenance**，npm 会把这次发布标记成
   **非 trusted 发布**，与历史版本（全部带 provenance）不一致；
2. 本机 `~/.npmrc` 里的 token 早已失效（2026-11-19 实测 `whoami` 401、publish 404），本地发只会制造一次失败；
3. 手工发布会绕开 CI 里的 `npm run test:ci` 与 `tag/package.json 版本一致性` 校验。

**正确流程**（缺一步就发不出去或发得不对）：

1. 改 `package.json` 的 `version` + 更新 README 版本表/变更说明；
2. commit 到 `main`（PR 合并）；
3. `git tag -a vX.Y.Z -m "vX.Y.Z: <一句话>"` 并 `git push origin vX.Y.Z`；
4. `gh release create vX.Y.Z --title ... --notes ...`；
5. 等 Actions 跑完 → `npm view @chenkai114/dsh-daemon version` 验证；
6. 若 CI 失败，**修完重新触发 workflow**（`gh workflow run publish.yml --ref main`），
   **不要**退回本地 `npm publish` 顶一下。

`prepublishOnly` 已加硬拦截：非 GitHub Actions 环境（且非 dry-run）直接报错退出。

## 依赖与 lockfile

- `package-lock.json` 必须指向 **registry.npmjs.org**（CI 用默认 registry，`resolved` 里出现
  npmmirror 等镜像 URL 会让 npm 报 `EALLOWREMOTE: Fetching packages of type "remote" have been disabled`
  而装不上依赖 —— 2026-11-19 v0.1.33 的发布就是这么失败的）。
- 重新生成 lock 时显式指定：`rm -rf node_modules package-lock.json && npm install --registry=https://registry.npmjs.org`。
- 不要在 lock 里留下任何本机绝对路径（历史上出现过指向 `/Users/.../node_modules/...` 的软链）。

## 测试

- `npm run test:ci`：CI 跑的那套（不依赖本机状态）
- `npm test`：全量，会真实拉起 dsh web 进程，本地跑较慢
- 修 bug 先让用例红、再转绿；新增行为要带一个能判别旧实现的用例（改坏可复现失败）
