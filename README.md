# xuanpingSOP · 我的亚马逊选品 SOP

亚马逊选品开品八步流程的个人 skill 存档（WorkBuddy skill 格式）。

## 流程概览

第 0 步 问清规则 → 1 选类目 → 2 筛产品 → 3 梳理定位 → 4 拓展对标 → 5 算利润并筛选 → 6 差评找改良点 → 7 合规初筛 → 8 产出开品文档（PRD + 工厂版规格书）

停下等人的三处：打样下单 · 备货 · 上架发布。

## 目录结构

```
amazon-eight-step-selection/
├── SKILL.md                        # 核心流程：总则 + 第 0–8 步 + 交付规范
├── references/rules.md             # 细则：七套筛选规则、利润公式与判定、供应商排序、口径红线、接口已知坑
└── assets/选品八步规则速查.html     # 无水印速查手册（自包含单页，浏览器直接打开）
```

## 本地安装（WorkBuddy）

把整个 `amazon-eight-step-selection/` 文件夹复制到用户级 skill 目录：

- Windows：`C:\Users\<用户名>\.workbuddy\skills\`
- macOS / Linux：`~/.workbuddy/skills/`

重开会话后，说「帮我选品」即可触发。

## 数据源

流程依赖多宝鱼 MCP（卖家精灵路径 + 1688 接口）。付费接口调用前先估次数与积分；详见 SKILL.md「付费数据源控费」一节。

---
整理于 2026-11-13 · 个人 SOP，无水印版本
