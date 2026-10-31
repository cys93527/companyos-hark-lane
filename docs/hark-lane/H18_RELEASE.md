# H18 — tag 与 GitHub release（Hark lane）

用户批准：2026-10-26 08:39（ROADMAP #14）；代码签名用户已决定不做（未签名安装包）。

## 规则
- 只为 CI 全绿的提交打 tag：hark-windows、hark-ubuntu、hark-installer、hark-isolation、hark-restart、hark-upgrade 在同一提交上全部 success。
- release 附件只来自该提交自己的 hark-installer 运行产物（不重新本地构建、不混用其他运行）：
  - `CompanyOS-Hark-Setup-<版本>-x64.exe`（未签名，Windows SmartScreen 会显示"未知发布者"）
  - `SHA256SUMS`（安装包与样例 zip 的 SHA-256；安装包哈希须与该 CI 运行的 installer-sha256.txt 一致）
  - `shop-inventory.zip`（H17 真机验收样例工作区，顶层目录 shop-inventory/，内容与 `scripts/hark/acceptance-fixture` 逐字节相同（不含 node_modules））
- tag 命名：`hark-v<apps/desktop 版本>`，指向上述提交；release 说明列出各工作流 run id。
- 状态措辞：所有结论只到 "Hark self-review PASS"；普通用户真机验收（H17_REAL_PC_ACCEPTANCE_CHECKLIST.md）与独立评审（H17_INDEPENDENT_REVIEW_PACKET.md）由用户/评审人执行，release 不代表已通过两者。

## 校验
`Get-FileHash .\CompanyOS-Hark-Setup-*.exe -Algorithm SHA256` 与 SHA256SUMS 对照。
