# Adolescent Anxiety Disorders Daily Literature Report

> 青少年焦慮症文獻日報 · 每日自動更新

## 網站

🔗 [https://u8901006.github.io/adolescent-anxiety-disoder/](https://u8901006.github.io/adolescent-anxiety-disoder/)

## 功能

- 每日 GMT+8 21:55 自動從 PubMed 抓取最新青少年焦慮症相關文獻
- 使用 Zhipu AI (GLM-5-Turbo) 分析、摘要、分類文獻
- 自動生成 HTML 報告並部署到 GitHub Pages
- 智慧去重：只摘要前 7 天內尚未總結的研究文獻
- 完整的 AI 模型備援機制：GLM-5-Turbo → GLM-4.7 → GLM-4.7-Flash

## 技術架構

- **執行環境：** Node.js 24 on GitHub Actions
- **文獻來源：** PubMed E-utilities API
- **AI 模型：** Zhipu GLM-5-Turbo（含 fallback chain）
- **搜尋範圍：** 60+ 青少年焦慮症相關期刊，涵蓋兒少精神科、心理學、兒科、公共衛生、神經科學等領域

## 授權

MIT License
