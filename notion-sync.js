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

    // 🔸 본문 블록 가져오기
    const mdBlocks = await n2m.pageToMarkdown(page.id);

    // 🔸 내용이 전혀 없으면 스킵
    if (!mdBlocks || mdBlocks.length === 0) {
        console.log(`⚠️  Skipping "${title}" (본문 없음)`);
        return;
    }

    // 🔸 Markdown 문자열 변환
    const mdString = n2m.toMarkdownString(mdBlocks)?.parent || "";
    if (!mdString.trim()) {
        console.log(`⚠️  Skipping "${title}" (본문 변환 결과 없음)`);
        return;
    }

    // 🔸 Front Matter 포함해 파일로 저장
    const frontMatter = matter.stringify(mdString, {
        layout: "post",
        title,
        date,
        categories: [category],
        tags,
        author: "frombunny",
    });

    const dir = `_posts/${category.toLowerCase()}`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

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
