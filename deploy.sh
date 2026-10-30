#!/bin/zsh
# 部署：蓋上新的 build 編號（頁面靠它判斷要不要自動換新版）→ commit → push
set -e
cd "${0:A:h}"
b=$(date +%Y%m%d%H%M)
sed -i '' -E "s/<meta name=\"build\" content=\"[0-9]+\">/<meta name=\"build\" content=\"$b\">/" index.html
git add -A
git commit -qm "${1:-更新}

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q
echo "build $b pushed"
