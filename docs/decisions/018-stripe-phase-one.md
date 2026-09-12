# ADR 018：第一阶段使用 Stripe

用户明确决定：“KFF 第一阶段接 Stripe。”这解除 TASK-094 的服务商选择阻塞；ADR 017 的 KFF 独立客户、订单、聊天和数据主权继续适用。

采用 Stripe 托管 Checkout Sessions，单次订单付款。服务器从不可变订单快照生成金额、币种、商品和关联标识；成功页仅展示提示。Stripe 事件经过原始请求验签、落库去重，再由 Worker 查询 Stripe Session / PaymentIntent，逐项核实后保存支付证据。测试支付独立标记，不计为真实确认收入。

API / SDK 固定为 `2026-08-26.dahlia` / `stripe@22.6.2`，根据安装时的官方 npm 包与其 API 版本声明核对。文档连接器需重新认证，CLI 安装因本机 PowerShell Archive 模块不可用而失败；已改用公开官方网页核对接口，不操作其他 Stripe 商户账号。

依据：[创建 Checkout Session](https://docs.stripe.com/api/checkout/sessions/create)、[Webhook](https://docs.stripe.com/webhooks)、[订单履约与延迟支付事件](https://docs.stripe.com/checkout/fulfillment?payment-ui=stripe-hosted)、[币种规则](https://docs.stripe.com/currencies)、[SDK 22.6.2](https://github.com/stripe/stripe-node/releases/tag/v22.6.2)。

当前开发和验证使用本地合成数据。实际 Stripe 商户账号、测试密钥、Webhook 签名密钥和真实测试证据尚待接入；不得据此宣称真实 Stripe 集成或完整项目已验收。
