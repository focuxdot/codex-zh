#!/usr/bin/env bash
# 创建 / 导入一张【固定复用】的自签名代码签名证书，供 build-codex-zh-staging-mac.mjs
# 的 --sign-identity 使用。
#
# 为什么要它：ad-hoc 签名（--sign -）没有身份，Designated Requirement 绑在 cdhash 上，
# 每次重打包 cdhash 都变 → 用户钥匙串里那条「Codex Storage Key」的 ACL 每版都对不上 →
# 每次更新都弹「codesign 想访问钥匙串」。改用一张【固定的】自签名证书后，DR 变成
#   identifier "ai.wokey.codex-zh" and certificate root = H"<证书 SHA-1>"
# 跨版本恒定 → ACL 一直匹配 → 最多弹一次（点「始终允许」），之后更新静默。
#
# 局限：自签名苹果不认，治不了 Gatekeeper（「无法验证开发者/已损坏」仍需去隔离/右键打开）。
# 彻底干净仍需 Developer ID + 公证。这里只解决「每次更新又弹钥匙串」。
#
# 用法：
#   scripts/create-mac-signing-identity.sh create   # 生成证书材料到 ~/.codex-zh-signing（已存在则跳过）
#   scripts/create-mac-signing-identity.sh import    # 把 p12 导入登录钥匙串并授权 codesign
#   scripts/create-mac-signing-identity.sh name      # 打印 --sign-identity 用的身份名
#
# 私钥材料留在 ~/.codex-zh-signing/（700），绝不进仓库。CI 用时把 codesign.p12 作为 secret
# 注入构建机，跑 import 即可。
set -euo pipefail

DIR="${CODEX_ZH_SIGNING_DIR:-$HOME/.codex-zh-signing}"
IDENTITY_NAME="Codex-ZH Self-Signed"
P12_PASS="${CODEX_ZH_P12_PASS:-codexzh}"
LOGIN_KC="$HOME/Library/Keychains/login.keychain-db"

cmd="${1:-}"

case "$cmd" in
  create)
    mkdir -p "$DIR"; chmod 700 "$DIR"
    if [[ -f "$DIR/codesign.p12" && "${2:-}" != "--force" ]]; then
      echo "已存在 $DIR/codesign.p12（加 --force 覆盖重建）。跳过。"
      exit 0
    fi
    cat > "$DIR/codesign.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Codex-ZH Self-Signed
O  = Wokey
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
    openssl req -x509 -newkey rsa:2048 -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
      -days 3650 -nodes -config "$DIR/codesign.cnf" 2>/dev/null
    # -legacy + SHA1/3DES：OpenSSL 3.x 默认的 PKCS12 MAC 苹果 Security.framework 读不了
    openssl pkcs12 -export -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
      -out "$DIR/codesign.p12" -passout "pass:$P12_PASS" -name "$IDENTITY_NAME" \
      -legacy -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES 2>/dev/null
    chmod 600 "$DIR"/*
    echo "已生成到 $DIR。证书 SHA-1（DR 会绑这个）："
    openssl x509 -in "$DIR/cert.pem" -noout -fingerprint -sha1
    ;;
  import)
    [[ -f "$DIR/codesign.p12" ]] || { echo "缺 $DIR/codesign.p12，先跑 create"; exit 1; }
    security import "$DIR/codesign.p12" -k "$LOGIN_KC" -P "$P12_PASS" \
      -T /usr/bin/codesign -T /usr/bin/security
    # 让 codesign 静默用私钥。-k 需要登录钥匙串密码；不传则 codesign 首次会弹框，
    # 届时点「始终允许」同样把 ACL 补上，之后静默。
    if [[ -n "${CODEX_ZH_LOGIN_KC_PASS:-}" ]]; then
      security set-key-partition-list -S apple-tool:,apple:,codesign: \
        -s -k "$CODEX_ZH_LOGIN_KC_PASS" "$LOGIN_KC" >/dev/null
      echo "已授权 codesign 静默使用私钥。"
    else
      echo "已导入。首次 codesign 会弹一次钥匙串框——点【始终允许】即可，之后静默。"
      echo "（或设 CODEX_ZH_LOGIN_KC_PASS 后重跑 import 以完全免弹。）"
    fi
    security find-identity -p codesigning "$LOGIN_KC" | grep "$IDENTITY_NAME" || true
    ;;
  name)
    echo "$IDENTITY_NAME"
    ;;
  *)
    echo "用法: $0 {create|import|name}" >&2
    exit 2
    ;;
esac
