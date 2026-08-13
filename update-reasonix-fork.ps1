# update-reasonix-fork.ps1
# 一键更新:把本地自定义改动 rebase 到官方最新代码,重新打包 vsix。
# 用法:右键"使用 PowerShell 运行",或在终端执行 .\update-reasonix-fork.ps1
#
# 说明:
# - 版本号打包为 99.0.0,永久高于官方版本(0.x/1.x),
#   所以 VS Code 的自动更新不会用官方版本覆盖你的自定义版。
# - 如果 rebase 冲突,脚本会停下;解决冲突后
#   git rebase --continue,再重跑本脚本即可。
# - 想向官方提交 PR 时,把 origin 改成你自己的 GitHub fork 后 push 即可。

$ErrorActionPreference = 'Stop'

# 本机 Node 目录(按需修改)
$NodeDir = 'D:\Geeksoft\Node.js'
$env:PATH = "$NodeDir;$env:PATH"

# 仓库定位:脚本若与仓库根(package.json)同目录则直接用,否则找同级 reasonix-vscode-dev
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path (Join-Path $here 'package.json')) {
    $repo = $here
}
else {
    $repo = Join-Path $here 'reasonix-vscode-dev'
}
Push-Location $repo

try {
    git checkout feature/composer-additions
    git checkout -- package.json package-lock.json   # 清掉上次打包可能留下的版本号残留
    # upstream = 官方仓库(更新源);origin = 你自己的 fork(用于提交 PR)
    if (-not (git remote | Select-String -SimpleMatch 'upstream' -Quiet)) {
        git remote add upstream https://github.com/SivanCola/reasonix-vscode.git
    }
    git fetch upstream main
    git rebase upstream/main
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'REBASE CONFLICT: solve it, run `git rebase --continue`, then re-run this script.' -ForegroundColor Yellow
        exit 1
    }
    npm install --no-audit --no-fund
    npm run lint
    npm test
    # 临时把版本号设为 99.0.0(永久高于官方版本),打包后立即还原,
    # 不产生任何 git commit,也不污染 PR 补丁。
    node -e 'const fs=require("fs");const p="package.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));j.version="99.0.0";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")'
    npx vsce package --no-dependencies -o dist/reasonix-vscode.vsix
    git checkout -- package.json package-lock.json
    Write-Host ''
    Write-Host 'DONE.' -ForegroundColor Green
    Write-Host 'Install with: code --install-extension dist/reasonix-vscode.vsix --force'
    Write-Host '(Then reload the VS Code window: Developer: Reload Window)'
}
finally {
    Pop-Location
}
