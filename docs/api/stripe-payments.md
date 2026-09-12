# KFF 第一期 Stripe 支付

依据 ADR-018 与 TASK-094。KFF 保留自有客户、会话、商品、订单和付款凭据，只把托管收银台与付款处理交给 Stripe。当前范围是运营人员为已确认订单生成单次付款链接；尚未实现退款、交付或访客自主下单。

## 配置实际测试账号

当前实际商户、API 密钥和 Webhook 签名密钥尚未配置。本地合成验证不会发送真实 Stripe 请求，也不能替代该步骤。密钥放在本机私密配置或部署环境的密钥管理器，不填入页面、聊天、提交文件或日志。

1. 确认要使用的 Stripe 测试商户账号 ID，以及 KFF 对应组织和品牌 UUID。KFF 管理员的 `GET /api/workspace` 返回服务端已授权的 `scope`。第一阶段使用独立商户，不使用 Connect 代收或组织级跨账号请求。
2. 在 Stripe 为这个商户准备测试 Restricted API key，按实际接口提供当前账号读取、Country Specs 读取、Checkout Sessions 创建/读取、PaymentIntents 读取权限。若所用权限配置不能读取必要对象，登记或核验会拒绝；根据 Stripe 返回的权限类别补足后再验证。采用服务端环境注入时，为引用 `KFF_STRIPE_PRIMARY` 配置以下变量：`KFF_STRIPE_PRIMARY_ORGANIZATION_ID`、`_BRAND_ID`、`_ACCOUNT_ID`、`_API_KEY`、`_WEBHOOK_SECRETS`。最后一项用逗号分隔轮换期间的签名密钥，最多三把。
3. 本机也可复制 [配置模板](../../config/stripe-secrets.example.json) 到 Git 已忽略的 `.kff/stripe-secrets.json`，在本地填入所有绑定和测试密钥。此文件只有服务端读取；组织、品牌、账号及 TEST/LIVE 必须全部一致。生产环境应使用密钥管理器注入环境变量。
4. 在订单页展开“Stripe 支付连接”，登记名称、商户 ID、TEST 模式和凭据引用。登记时服务器实际查询 Stripe 商户身份；成功后获得连接 ID。Webhook 路径为 `POST /api/stripe/webhooks/<connection_id>`。本地转发或真实 HTTPS 地址的配置，需要使用选定测试账号验证；当前未创建公网端点。
5. 配置 Webhook 接收 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`、`checkout.session.expired`，事件 API 版本固定 `2026-08-26.dahlia`。保存此端点的签名密钥；CLI 转发密钥与 Dashboard 端点密钥分别管理。端点尚未创建时可以先准备端点及密钥，再完成连接登记并更新端点 URL 中的连接 ID；上线前验证真实投递路径。
6. Web 与 Worker 需要同样的私密配置。设置 `KFF_APP_ORIGIN` 为受控站点 HTTPS 源地址；本机允许 loopback HTTP。先完成测试商户的真实 Checkout、签名回调、服务器查询与重放验证。正式收款还须单独提供 LIVE 凭据、连接和明确放行；默认 `KFF_ENABLE_LIVE=false`。

本地配置仅提供读取模板，没有自动创建账号、Webhook、密钥或进行支付的脚本。当前 Stripe 文档连接器还需要重新认证；本次使用公开官方文档和已安装 SDK 核对协议。

## API 与权限

除 Stripe 原始签名回调外，接口都需要 KFF 运营登录，作用域由服务端确定，写请求检查同源。请求不接受客户端价格、币种覆盖、付款成功状态或商户私钥。

| 接口 | 行为与权限 |
| --- | --- |
| `GET /api/payments?order=<id>` | 查看当前品牌连接、付款请求、已核实记录和事件；可按本品牌订单限定 |
| `POST /api/stripe-connections` | 管理员登记固定商户、模式与凭据引用，先查询实际账号身份 |
| `POST /api/stripe-connections/:id/controls` | 管理员按版本暂停/恢复新付款请求，记录原因与请求去重 |
| `POST /api/orders/:id/stripe-checkouts` | 操作员确认订单版本、快照摘要和连接，持久保存原请求后返回 202 |
| `POST /api/payment-checkouts/:id/recheck` | 操作员填写原因，排队查询已知的原 Stripe 对象；不会重新创建付款 |
| `POST /api/stripe/webhooks/:id` | 原始字节验签及持久收件；不依赖运营登录和浏览器同源头 |
| `GET /payment-return` | 公共提示页，不读取查询参数来宣告付款，也不暴露订单或客户资料 |

管理员暂停连接或组织/品牌停止后，新的外部创建被拒绝。已经提交的对象继续只读核对，合法回调仍接收。停止开关不会使已发出的 Stripe 付款链接失效；当前没有远程过期或退款操作，须在 Stripe 测试联调和后续退款任务中验证相应流程。

## 固定请求与可靠核验

服务器从不可变订单快照生成整数金额与商品列表，同时固定 `kff_order_id`、`kff_checkout_id`、`kff_brand_id`、`kff_snapshot_hash` 到 Session 和 PaymentIntent 元数据。服务端按 Stripe 收款单位检查币种精度及安全整数，ISK/UGX 要求整主单位单价；商户地区允许币种由 Country Specs 查询。实际提供方的支付方式、最低/最高金额和账号可用性仍以实际测试结果为准。

付款方式使用 Stripe 动态配置；不启用自动税、自动换币或优惠码改变已确认总额。托管地址只允许 `https://checkout.stripe.com`，自定义收银域名未接入。

每笔请求永久保存精确参数，幂等键为 `kff-checkout-<支付请求 UUID>`。网络中断或响应丢失后，在首次提交后的 23 小时窗口内重试同一键和同一参数。超过窗口且原对象未知则进入 `NEEDS_HUMAN`，阻止新建与取消；不会用新键猜测重做。已知 Session 的“核对原支付”只查询该对象。查询失败不能证明创建失败，也不能开放第二笔付款。

Webhook 原始请求上限 512 KiB；校验签名及 300 秒时间窗口、API 版本、模式、独立商户范围，删除无关字段后保存最小事件。事件与共用入站记录同事务提交后才返回 `STORED`；数据库失败返回错误以便 Stripe 重试。重复事件返回已有收件确认，同一事件 ID 内容变化报冲突。

Worker 使用带 token 的 90 秒租约。事件回调只是核验触发器，Worker 还须查询该商户的 Session 和 PaymentIntent，逐项匹配对象、订单、品牌、快照、金额、币种与模式；只有 Session 完成且已付款、PaymentIntent 成功且到账金额完全一致，才在同一事务写入不可变付款凭据、订单付款状态、事件完成和审计。旧租约结果不能覆盖新租约；重复和乱序事件不会重复入账或退回已核实状态。提供方异常有上限地退避重试，之后保留人工处理状态。

`VERIFIED_TEST_PAID` 明确表示测试付款；只有 LIVE 且非合成的已核实凭据产生 `VERIFIED_PAID`。客户档案分别统计真实付款和测试记录，人工成交标签不影响该统计。这里是付款总额凭据，尚不包含退款、争议、Stripe 手续费或结算净额账本。

## 当前验证与运维边界

本地验证覆盖真实 SDK 的 HTTP 编码、金额单位、固定请求、回调原始签名、入站持久确认、重复/乱序、延迟付款、伪造及范围错误、查询失败、数据库故障、租约过期、暂停/恢复、取消限制、浏览器及生产构建流程。测试驱动和合成连接由服务端注入，日常 Worker 不处理合成连接，浏览器 API 没有开启合成支付驱动的参数。

实际账号、实际 Stripe 测试收银台、真实 Webhook 投递、密钥轮换及生产网络验收尚待执行，不把本地结果计为 TASK-094 或 G3 完整验收。结构变更只用新迁移；回滚保留现有订单、支付请求和核验证据，先暂停新创建并保留在途核对能力，不能删除未知付款或回滚已核实付款状态。

协议依据：[Checkout 创建接口](https://docs.stripe.com/api/checkout/sessions/create)、[Webhook 原始签名与投递](https://docs.stripe.com/webhooks)、[延迟付款与服务器核验](https://docs.stripe.com/checkout/fulfillment?payment-ui=stripe-hosted)、[币种规则](https://docs.stripe.com/currencies)。
