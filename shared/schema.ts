import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const articles = sqliteTable("articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  site: text("site").notNull(),          // 'channelnews' | 'hifipig' | 'whathifi' | 'stereonet'
  title: text("title").notNull(),
  url: text("url").notNull().unique(),
  publishedAt: text("published_at").notNull(),   // ISO date string
  publishedDate: text("published_date").notNull(), // YYYY-MM-DD for grouping
  contentType: text("content_type").notNull(),    // 'review' | 'news' | 'feature' | 'opinion' | 'unknown'
  categories: text("categories").notNull(),       // JSON array string
  author: text("author"),                          // dc:creator from RSS, nullable
  brands: text("brands"),                           // JSON array of extracted brand/product terms
  fetchedAt: text("fetched_at").notNull(),
});

export const insertArticleSchema = createInsertSchema(articles).omit({ id: true });
export type InsertArticle = z.infer<typeof insertArticleSchema>;
export type Article = typeof articles.$inferSelect;

export const refreshLog = sqliteTable("refresh_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  completedAt: text("completed_at").notNull(),
  articlesAdded: integer("articles_added").notNull(),
  status: text("status").notNull(),
  notes: text("notes"),
});

export type RefreshLog = typeof refreshLog.$inferSelect;
