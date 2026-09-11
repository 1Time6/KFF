# ADR-014：明确类型与来源的文件往返

状态：已实现，验证结果见本地检查点。

人工文件沿用采集查询、身份及不可变观察模型；独立的文件/预览/确认表只承担上传与确认过程，不另建客户或账号主数据。确认只处理所见有效行，错误行必须明确排除，来源变化要求重新预览。请求重放与同内容重复导入不能多写观察。

CSV 不具备 Excel 单元格类型声明能力。采用带版本标记的文本保护格式，回导单次解码；XLSX 使用真正的文本单元格。公式作为输入类型单独拒绝，文本形式的 `=1+1` 原样保存。四种字段状态单独导出以保证可逆。

独立 XLSX 样本由 bundled artifact-tool 生成，发现 ExcelJS 读取器无法读取其合法命名空间前缀，因此导入以命名空间感知的 Saxes 读取必要 Open XML 结构；ExcelJS 只用于产品导出。ZIP 和 XML 在受限子进程中验证；不通过重写前缀或执行公式修复用户数据。

ExcelJS 的文本和公式类型及缓冲区写入 API 参见 [ExcelJS 官方说明](https://github.com/exceljs/exceljs#value-types)。CSV 输入使用保持字符串的解析选项，参见 [csv-parse 官方选项](https://csv.js.org/parse/options/)。ZIP 逐项读取与实际解压尺寸验证参考 [yauzl 官方文档](https://github.com/thejoshwolfe/yauzl#readme)；命名空间及 XML 错误处理参考 [Saxes 官方文档](https://github.com/lddubeau/saxes#readme)。

未用真实账号或客户文件验收，不把本次本地导入证据用作 Facebook 数据源或外联授权。Supabase 托管环境、OS 级进程隔离、备份和下载副本治理仍按对应任务单独验收。
