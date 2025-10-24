import "dotenv/config";
import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import fs from "fs";
import matter from "gray-matter";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

const databaseIds = process.env.NOTION_DATABASE_IDS.split(",");

async function fetchPosts(databaseId) {
    const { results } = await notion.databases.query({
        database_id: databaseId.trim(),
        filter: {
            property: "Published",
            checkbox: { equals: true },
        },
    });
    return results;
}

async function toMarkdown(page) {
    const props = page.properties;
    const title = props.Title.title[0]?.plain_text || "Untitled";
    const slug =
        props.Slug?.rich_text?.[0]?.plain_text ||
        title.toLowerCase().replace(/\s+/g, "-");
    const category = props.Category?.select?.name || "General";
    const tags = props.Tags?.multi_select?.map(t => t.name) || [];
    const date = props.Date?.date?.start || new Date().toISOString().slice(0, 10);

    // 🔸 Notion → Markdown 변환
    const mdBlocks = await n2m.pageToMarkdown(page.id);

    // 🔸 본문이 비어 있으면 skip
    if (!mdBlocks || mdBlocks.length === 0) {
        console.log(`⚠️  Skipping "${title}" (본문 없음)`);
        return;
    }

    // notion-to-md 최신버전은 { parent, children } 반환 가능 → parent만 사용
    const mdString = n2m.toMarkdownString(mdBlocks)?.parent || "";

    // 🔸 변환 결과가 빈 문자열이면 skip
    if (!mdString.trim()) {
        console.log(`⚠️  Skipping "${title}" (본문 변환 결과 없음)`);
        return;
    }

    // 🔸 Chirpy에서 토글/코드 깨짐 방지
    // ```코드``` → {% raw %}```{% endraw %} 으로 자동 감싸기
    const safeMd = mdString.replace(/```/g, "{% raw %}```{% endraw %}");

    // 🔸 토글(<details>) 블록 내에서도 안전하게 코드 렌더링
    // <details> 블록 앞뒤에 공백 한 줄 추가
    const formattedMd = safeMd
        .replace(/<details>/g, "\n<details>\n")
        .replace(/<\/details>/g, "\n</details>\n");

    // 🔸 Front Matter + 본문 조합
    const frontMatter = matter.stringify(formattedMd, {
        layout: "post",
        title,
        date,
        categories: [category],
        tags,
        author: "frombunny",
    });

    // 🔸 카테고리별 폴더 생성
    const dir = `_posts/${category.toLowerCase()}`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 🔸 파일 생성
    const filename = `${date}-${slug}.md`;
    fs.writeFileSync(`${dir}/${filename}`, frontMatter);

    console.log(`📝  Created post: ${dir}/${filename}`);
}



(async () => {
    let total = 0;
    for (const id of databaseIds) {
        const posts = await fetchPosts(id);
        console.log(`📘 Database ${id}: ${posts.length} posts`);
        for (const post of posts) {
            await toMarkdown(post);
            total++;
        }
    }
    console.log(`✅ Synced total ${total} posts from ${databaseIds.length} databases`);
})();
