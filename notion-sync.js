import "dotenv/config";
import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import fs from "fs";
import matter from "gray-matter";
import download from "image-downloader";
import path from "path";

/* -----------------------------
 * 🖼️ 이미지 다운로드 (중복 방지 + 제목별 폴더 저장)
 * ----------------------------- */
// 🖼️ 이미지 다운로드 (중복 방지 + 제목별 폴더 저장)
async function backupImage(url, postSlug) {
    try {
        // ✅ 폴더명에서 한글/특수문자 제거 (Jekyll-safe)
        const safeSlug = postSlug
            .replace(/[^a-zA-Z0-9ㄱ-힣_-]/g, "-") // 특수문자 → -
            .replace(/--+/g, "-") // 중복된 하이픈 정리
            .trim();

        const baseDir = path.join(process.cwd(), "assets/images", safeSlug);
        if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

        const originalName = path.basename(new URL(url).pathname).split("?")[0];
        const ext = path.extname(originalName);
        const base = path.basename(originalName, ext);

        let dest = path.join(baseDir, originalName);
        let counter = 1;

        // 🔁 같은 이름 있으면 -1, -2 붙이기
        while (fs.existsSync(dest)) {
            dest = path.join(baseDir, `${base}-${counter}${ext}`);
            counter++;
        }

        await download.image({ url, dest });
        console.log(`✅ 이미지 저장 완료: ${safeSlug}/${path.basename(dest)}`);

        // Markdown에서 쓸 경로 반환
        return `/assets/images/${safeSlug}/${path.basename(dest)}`;
    } catch (err) {
        console.warn(`⚠️ 이미지 다운로드 실패 (${url}) → ${err.message}`);
        return url;
    }
}


/* -----------------------------
 * 🧠 Notion 설정
 * ----------------------------- */
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });
const databaseIds = process.env.NOTION_DATABASE_IDS.split(",");

/* -----------------------------
 * 📦 게시글 가져오기
 * ----------------------------- */
async function fetchPosts(databaseId) {
    const { results } = await notion.databases.query({
        database_id: databaseId.trim(),
        filter: { property: "Published", checkbox: { equals: true } },
    });
    return results;
}

/* -----------------------------
 * ✍️ Notion → Markdown 변환
 * ----------------------------- */
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
    let mdString = typeof mdResult === "string" ? mdResult : mdResult?.parent || "";

    const codeBlocks = [];
    const toggleBlocks = [];

    // 🔒 코드 & 토글 보호
    mdString = mdString.replace(/```[\s\S]*?```/g, (block) => {
        codeBlocks.push(block);
        return `{{CODE_BLOCK_${codeBlocks.length - 1}}}`;
    });

    mdString = mdString.replace(/<details>[\s\S]*?<\/details>/g, (block) => {
        toggleBlocks.push(block);
        return `{{TOGGLE_BLOCK_${toggleBlocks.length - 1}}}`;
    });

    // ✨ 줄바꿈 처리
    mdString = mdString
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/(^|\n)> ?([^\n]+)/g, "$1> $2")
        .replace(/(> [^\n]+)(?=\n(?!>))/g, "$1\n")
        .replace(/(^[^>`{\n].*?)\n(?![`>{])/g, "$1<br>\n")
        .replace(/(^|\n)\s*\n/g, "\n\n");

    // 🖼️ 이미지 다운로드 및 경로 치환
    const imageRegex = /!\[.*?\]\((https:\/\/prod-files-secure\.s3.*?)\)/g;
    const imageUrls = [...mdString.matchAll(imageRegex)].map((m) => m[1]);

    for (const url of imageUrls) {
        const localPath = await backupImage(url, slug);
        // 교체: Notion URL → 로컬 경로
        mdString = mdString.replace(url, localPath);
    }

    // 💄 summary 내 Markdown 문법 변환
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

    // 🪶 토글 내부 정리
    toggleBlocks.forEach((block, i) => {
        let toggle = block;

        // markdown="1" 추가
        toggle = toggle.replace(
            /<details(?![^>]*markdown="1")>/,
            '<details markdown="1">'
        );

        // <summary> 안의 **굵게**, *기울임*, `코드` 변환
        toggle = toggle.replace(
            /<summary>([\s\S]*?)<\/summary>/g,
            (_, inner) => {
                let processed = inner
                    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                    .replace(/(^|[^*])\*(.*?)\*(?!\*)/g, "$1<em>$2</em>")
                    .replace(/`([^`]+)`/g, "<code>$1</code>")
                    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .replace(/&amp;/g, "&");
                return `<summary>${processed}</summary>`;
            }
        );

        // 나머지 정리
        toggle = toggle
            .replace(/(<summary[\s\S]*?<\/summary>)(?!\n\n)/, "$1\n\n")
            .replace(/\\\*/g, "*")
            .replace(/\\_/g, "_")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/```(\w+)?\n([\s\S]*?)\n```/g, "```$1\n$2\n```")
            .replace(/\n{3,}/g, "\n\n");

        toggleBlocks[i] = toggle;
    });


    // 🧩 블록 복원
    mdString = mdString
        .replace(/{{TOGGLE_BLOCK_(\d+)}}/g, (_, idx) => toggleBlocks[idx])
        .replace(/{{CODE_BLOCK_(\d+)}}/g, (_, idx) => codeBlocks[idx]);

    // 🪶 Front Matter 추가
    const frontMatter = matter.stringify(mdString, {
        layout: "post",
        title,
        date,
        categories,
        tags,
        author: "frombunny",
    });

    // 🗂️ 파일 저장
    const dirPath = `_posts/${categoryList.map((c) => c.toLowerCase()).join("/")}`;
    fs.mkdirSync(dirPath, { recursive: true });

    const filename = `${date}-${slug}.md`;
    fs.writeFileSync(`${dirPath}/${filename}`, frontMatter);
    console.log(`✅ Synced: ${filename}`);
}

/* -----------------------------
 * 🚀 실행
 * ----------------------------- */
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
