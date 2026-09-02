import { getCollection } from "astro:content";
import type { CollectionEntry } from "astro:content";

export type Post = CollectionEntry<"posts">;

/** base 前缀（部署在子路径如 /personal-blog/ 时，内部链接必须带上前缀） */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** 生成带 base 前缀的内部链接；外部 http 链接原样返回 */
export function u(path: string): string {
  return /^https?:\/\//.test(path) ? path : BASE + path;
}

/** glob 加载的 id 形如 `slug.md`，这里去掉扩展名得到路由 slug */
export function postSlug(post: Post): string {
  return post.id.replace(/\.(md|mdx)$/, "");
}

/**
 * 分类/标签 URL slug：Astro 动态路由参数中不能包含 "/"（如 "CI/CD" 标签），
 * 把路径敏感字符替换为 "-"，展示时仍用原名。
 */
export function termSlug(name: string): string {
  return name.replace(/[/?#%\\]+/g, "-");
}

export async function getAllPosts(): Promise<Post[]> {
  const posts = await getCollection("posts");
  return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export async function getFeaturedPosts(limit = 3): Promise<Post[]> {
  const posts = await getAllPosts();
  return posts.filter((p) => p.data.featured).slice(0, limit);
}

/** 估算阅读时长：中文 400 字/分钟 + 英文 200 词/分钟 */
export function readingTime(post: Post): number {
  const body = post.body || "";
  const cjk = (body.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (body.match(/[a-zA-Z0-9]+/g) || []).length;
  return Math.max(1, Math.round(cjk / 400 + words / 200));
}

export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}`;
}

export interface CatCount {
  name: string;
  count: number;
}

export async function getCategories(): Promise<CatCount[]> {
  const posts = await getAllPosts();
  const map = new Map<string, number>();
  for (const p of posts) {
    for (const c of p.data.categories) {
      map.set(c, (map.get(c) || 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
}

export async function getTags(): Promise<CatCount[]> {
  const posts = await getAllPosts();
  const map = new Map<string, number>();
  for (const p of posts) {
    for (const t of p.data.tags) {
      map.set(t, (map.get(t) || 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
}
