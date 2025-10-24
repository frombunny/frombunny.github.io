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

    // ✅ Category path (예: JAVA/[김영한의 실전 자바] 기본편)
    const categoryList =
        props.Category?.multi_select?.map((c) => c.name.trim()) || ["General"];
    const categoryPath = categoryList.join("/");
    const categories = [categoryPath];

    // ✅ Tags (multi_select or select 둘 다 지원)
    const tags =
        props.Tags?.multi_select?.length > 0
            ? props.Tags.multi_select.map((t) => t.name.trim())
            : props.Tags?.select
                ? [props.Tags.select.name.trim()]
                : [];

    const date =
        props.Date?.date?.start || new Date().toISOString().slice(0, 10);

    // ✅ Markdown 변환
    const mdBlocks = await n2m.pageToMarkdown(page.id);
    const mdResult = n2m.toMarkdownString(mdBlocks);
    let mdString = typeof mdResult === "string" ? mdResult : mdResult?.parent || "";

    // ✅ 코드 블록 보호
    const codeBlocks = [];
    mdString = mdString.replace(/```[\s\S]*?```/g, (block) => {
        codeBlocks.push(block);
        return `{{CODE_BLOCK_${codeBlocks.length - 1}}}`;
    });

    mdString = mdString
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")

        // ✅ 인용문 안의 번호 리스트 줄 구분 강제
        .replace(/(^|\n)>(\s*)(\d+)\.\s/g, "$1>\n$2$3. ")

        // ✅ 인용문 한 줄씩 정리 (공백 1칸 유지)
        .replace(/(^|\n)> ?([^\n]*)/g, "$1> $2")

        // ✅ 인용문이 끝나면 반드시 한 줄 개행 추가 (코드블록이나 문단과 구분)
        .replace(/(> [^\n]+)(?=\n(?!>))/g, "$1\n")

        // ✅ 인용문 마지막 줄 다음이 코드블록이면 빈 줄 추가
        .replace(/(> [^\n]+)\n(?=```)/g, "$1\n\n")

        // ✅ 연속된 인용문 줄 사이에는 한 줄만 유지 (중복 제거)
        .replace(/(> [^\n]+)\n{2,}(?=>)/g, "$1\n")

        // ✅ 문단 간 줄바꿈 (단, 인용문 내부 제외)
        .replace(/(^[^>].*?)\n(?!>)/g, "$1\n\n")

        // ✅ 코드블록 복원
        .replace(/{{CODE_BLOCK_(\d+)}}/g, (_, idx) => codeBlocks[idx]);

    if (!mdString.trim()) {
        console.log(`⚠️ Skipped empty post: ${title}`);
        return;
    }

    // ✅ Front matter
    const frontMatter = matter.stringify(mdString, {
        layout: "post",
        title,
        date,
        categories,
        tags,
        author: "frombunny",
    });

    // ✅ 폴더 경로 반영 (소문자 변환)
    const dirPath = `_posts/${categoryList.map((c) => c.toLowerCase()).join("/")}`;
    fs.mkdirSync(dirPath, { recursive: true });

    const filename = `${date}-${slug}.md`;
    fs.writeFileSync(`${dirPath}/${filename}`, frontMatter);
    console.log(`✅ Synced: ${filename}`);
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
