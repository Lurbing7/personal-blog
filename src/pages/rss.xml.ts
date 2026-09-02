import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getAllPosts, postSlug } from "@/lib/posts";

export async function GET(context: APIContext) {
  const posts = await getAllPosts();
  const site = new URL(import.meta.env.BASE_URL, context.site);
  return rss({
    title: "云忆 · Java 后端工程师的技术博客",
    description: "记录技术学习、项目实践与踩坑经验",
    site: site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: `/post/${postSlug(post)}/`,
      categories: post.data.categories,
    })),
  });
}
