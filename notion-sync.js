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

    const categoryList =
        props.Category?.multi_select?.map((c) => c.name.trim()) || ["General"];
    const categories = [categoryList.join("/")];

    const tags =
        props.Tags?.multi_select?.length > 0
            ? props.Tags.multi_select.map((t) => t.name.trim())
            : props.Tags?.select
                ? [props.Tags.select.name.trim()]
                : [];

    const date =
        props.Date?.date?.start ||
        page.created_time?.slice(0, 10) ||
        new Date().toISOString().slice(0, 10);

    const mdBlocks = await n2m.pageToMarkdown(page.id);
    const mdResult = n2m.toMarkdownString(mdBlocks);
    let mdString =
        typeof mdResult === "string" ? mdResult : mdResult?.parent || "";

    const codeBlocks = [];
    const toggleBlocks = [];

    mdString = mdString.replace(/```[\s\S]*?```/g, (block) => {
        codeBlocks.push(block);
        return `{{CODE_BLOCK_${codeBlocks.length - 1}}}`;
    });

    mdString = mdString.replace(/<details>[\s\S]*?<\/details>/g, (block) => {
        toggleBlocks.push(block);
        return `{{TOGGLE_BLOCK_${toggleBlocks.length - 1}}}`;
    });

    mdString = mdString
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/(^|\n)> ?([^\n]+)/g, "$1> $2")
        .replace(/(> [^\n]+)(?=\n(?!>))/g, "$1\n")
        .replace(/(^[^>`{\n].*?)\n(?![`>{])/g, "$1<br>\n")
        .replace(/(^|\n)\s*\n/g, "\n\n");

    // ✅ summary 안의 Markdown 문법 수동 변환 (**bold**, *italic*, [link])
    mdString = mdString.replace(
        /<summary>([\s\S]*?)<\/summary>/g,
        (_, inner) => {
            let processed = inner
                // bold → <strong>
                .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                // italic → <em>
                .replace(/(^|[^*])\*(.*?)\*(?!\*)/g, "$1<em>$2</em>")
                // inline code → <code>
                .replace(/`([^`]+)`/g, "<code>$1</code>")
                // link → <a>
                .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

            // ✅ HTML 인코딩 복원 추가! (핵심)
            processed = processed
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&amp;/g, "&");

            return `<summary>${processed}</summary>`;
        }
    );


    toggleBlocks.forEach((block, i) => {
        let toggle = block;

        // details에 markdown="1" 보강
        toggle = toggle.replace(
            /<details(?![^>]*markdown="1")>/,
            '<details markdown="1">'
        );

        // summary 뒤에 빈줄 하나 보장
        toggle = toggle.replace(/(<summary[\s\S]*?<\/summary>)(?!\n\n)/, "$1\n\n");

        // ✅ summary 안의 Markdown(**, *, ``, [link]()) → HTML 로컬 변환
        toggle = toggle.replace(/<summary([^>]*)>([\s\S]*?)<\/summary>/, (m, attrs, inner) => {
            let processed = inner
                // bold → <strong>
                .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                // italic → <em>  (단일 *만 잡도록 정규식 유의)
                .replace(/(^|[^*])\*(.*?)\*(?!\*)/g, "$1<em>$2</em>")
                // inline code → <code>
                .replace(/`([^`]+)`/g, "<code>$1</code>")
                // link → <a>
                .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
                // HTML 인코딩 복원
                .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

            return `<summary${attrs}>${processed}</summary>`;
        });

        // 토글 내부 이스케이프 정리
        toggle = toggle
            .replace(/\\\*/g, "*")
            .replace(/\\_/g, "_")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&");

        // 코드블록은 ``` 그대로 유지
        toggle = toggle.replace(/```(\w+)?\n([\s\S]*?)\n```/g, "```$1\n$2\n```");

        // 중복 개행 정리
        toggle = toggle.replace(/\n{3,}/g, "\n\n");

        toggleBlocks[i] = toggle;
    });


    mdString = mdString
        .replace(/{{TOGGLE_BLOCK_(\d+)}}/g, (_, idx) => toggleBlocks[idx])
        .replace(/{{CODE_BLOCK_(\d+)}}/g, (_, idx) => codeBlocks[idx]);

    // ✅ Front matter 추가
    const frontMatter = matter.stringify(mdString, {
        layout: "post",
        title,
        date,
        categories,
        tags,
        author: "frombunny",
    });

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
