# 500 条译文的模型辅助复核口径

只读对应 blind-review/batch-XX.json，不读取 mapping、模型名、延迟、其他结果或作者身份。每批100条，每条同时复核全部匿名模型的中英文。参考译文为合成参考，不是人工金标准；原始日语和给定上下文优先。不要调用任何模型API、网络、授权或凭证。

逐条考虑否定与范围、数字单位、时态、许可／禁止、施受关系、引述主体、改口最终结果、不确定语气、术语、遗漏与无依据增补。不能只按参考字符串或关键词完全一致判断。日语省略主语且上下文不唯一时，合理的we／you补足不自动算错；不明性别的人名不得被擅自具体化。区分可接受措辞、轻微问题、明确关键语义错误和需要人工裁定的歧义。长句须覆盖所有主要分句。

每批输出一个JSON，格式：

```json
{
  "batch": "01",
  "method": "blind model-assisted semantic review; not human accuracy",
  "assessments": [
    {"id": "案例ID", "A": {"zh": "acceptable", "en": "acceptable"}, "B": {"zh": "acceptable", "en": "acceptable"}, "C": {"zh": "acceptable", "en": "acceptable"}}
  ],
  "findings": [
    {"id": "案例ID", "label": "A", "language": "zh", "severity": "critical", "source_quote": "相关日语", "target_quote": "实际译文", "reason": "准确说明差异", "suggestion": "最小忠实修正"}
  ],
  "reference_issues": []
}
```

assessments必须覆盖全部100个ID，保留原ID类型为字符串。每种语言状态从acceptable／minor／critical／ambiguous／unavailable中选择；非acceptable项须有对应finding，unavailable除外。technical unavailable不能记为语义正确，也不因缺少文字而杜撰翻译错误。reference_issues记录原文与参考不一致或核对点不充分之处，不能为了匹配错误参考处罚正确译文。

所有发现由主代理或第二名匿名复核者二次核查；保留争议，不据此生成“人工准确率”。汇总时分别报已复核数、技术失败数、被标记的关键语义问题数和争议数，原18条与新482条分列。
