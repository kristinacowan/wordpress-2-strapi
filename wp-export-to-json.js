const path = require("path");
const fs = require("fs");
const parser = require("fast-xml-parser");
const he = require("he");
const _get = require("lodash.get");
const htmlUrls = require("html-urls");
const download = require("image-downloader");
const isImageUrl = require("is-image-url");
const moment = require("moment");
const TurndownService = require("turndown");
const escapeRegExp = require("escape-string-regexp");
const phpUnserialize = require('phpunserialize');
require("dotenv").config();


const globalReplace = console.log("Parsing wordpress export file");

const xmlData = fs.readFileSync("./wp-export.xml", "utf8");
const outputFile = "./wp-export.json";
const outputDir = "./wp-export/";
const uploadsDir = path.join(outputDir, "uploads");

const nullIfEmpty = (o) => {
  if (o && o.length > 0) return o;
  return null;
};

const fso = (path, o, strFn) => {
  let str = typeof o === "string" ? o : JSON.stringify(o, null, "  ");
  if (strFn) str = strFn(str);
  fs.writeFileSync(path, str, "utf8");
};

const allUrls = [];

const disregardPostTypes = process.env.WP_IGNORE_POST_TYPES.split(',');

const options = {
  attributeNamePrefix: "@_",
  attrNodeName: "attr", //default is 'false'
  textNodeName: "#text",
  ignoreAttributes: true,
  ignoreNameSpace: false,
  allowBooleanAttributes: false,
  parseNodeValue: true,
  parseAttributeValue: false,
  trimValues: true,
  cdataTagName: "__cdata", //default is 'false'
  cdataPositionChar: "\\c",
  parseTrueNumberOnly: false,
  arrayMode: false, //"strict"
  attrValueProcessor: (val, attrName) =>
    he.decode(val, { isAttributeValue: true }), //default is a=>a
  tagValueProcessor: (val, tagName) => he.decode(val), //default is a=>a
  stopNodes: ["parse-me-as-string"],
};

let jsonObj = null;
if (parser.validate(xmlData) === true) {
  //optional (it'll return an object in case it's not valid)
  jsonObj = parser.parse(xmlData, options);
}

// Intermediate obj
const tObj = parser.getTraversalObj(xmlData, options);
jsonObj = parser.convertToJson(tObj, options);
fso(outputFile, jsonObj, (s) => {
  if (
    process.env.STRAPI_GLOBAL_REPLACE_FROM &&
    process.env.STRAPI_GLOBAL_REPLACE_FROM.length > 0 &&
    process.env.STRAPI_GLOBAL_REPLACE_TO &&
    process.env.STRAPI_GLOBAL_REPLACE_TO.length > 0
  ) {
    const fromParts = process.env.STRAPI_GLOBAL_REPLACE_FROM.split(",");
    const toParts = process.env.STRAPI_GLOBAL_REPLACE_TO.split(",");
    if (fromParts.length !== toParts.length) {
      console.error(
        "STRAPI_GLOBAL_REPLACE_FROM and STRAPI_GLOBAL_REPLACE_TO arrays must be of equal length"
      );
      return s;
    }
    let s1 = s;
    for (let gri = 0; gri < fromParts.length; gri++) {
      const from = fromParts[gri];
      const to = toParts[gri];
      s1 = s1.replace(new RegExp(escapeRegExp(from), "gi"), to);
    }
    return s1;
  }
});
jsonObj = JSON.parse(fs.readFileSync(outputFile, "utf8"));

const channel = _get(jsonObj, "rss.channel");
if (!channel) return;

const {
  title,
  link,
  description,
  pubDate,
  language,
  generator,
  ...otherProps
} = channel;
const site = {
  title,
  link,
  description,
  pubDate,
  language,
  baseUrl: _get(otherProps, "wp:base_site_url"),
  blogUrl: _get(otherProps, "wp:base_blog_url"),
  generator,
  postTypes: (_get(otherProps, "item") || []).reduce((arr, item) => {
    const postType = _get(item, ["wp:post_type", "__cdata"]);
    if (!arr.includes(postType) && !disregardPostTypes.includes(postType))
      arr.push(postType);
    return arr;
  }, []),
};
const authors = (_get(otherProps, "wp:author") || []).map((a) => {
  return {
    id: _get(a, ["wp:author_id"]),
    login: _get(a, ["wp:author_login", "__cdata"]),
    email: _get(a, ["wp:author_email", "__cdata"]),
    displayName: _get(a, ["wp:author_display_name", "__cdata"]),
    firstName: _get(a, ["wp:author_first_name", "__cdata"]),
    lastName: _get(a, ["wp:author_last_name", "__cdata"]),
  };
});
const categories = (_get(otherProps, "wp:category") || []).map((a) => {
  return {
    id: _get(a, ["wp:term_id"]),
    slug: _get(a, ["wp:category_nicename", "__cdata"]),
    title: _get(a, ["wp:cat_name", "__cdata"]),
    parentId: null,
    parentSlug: _get(a, ["wp:category_parent", "__cdata"], null),
  };
});
categories.forEach((category) => {
  if (category.parentSlug && category.parentSlug.length) {
    const parentCategory = categories.find(
      (c) => c.slug === category.parentSlug
    );
    if (parentCategory) {
      category.parentId = parentCategory.id;
    }
  }
  delete category.parentSlug;
});
const tags = (_get(otherProps, "wp:tag") || []).map((a) => {
  return {
    id: _get(a, ["wp:term_id"]),
    slug: _get(a, ["wp:tag_slug", "__cdata"]),
    title: _get(a, ["wp:tag_name", "__cdata"]),
  };
});

const populateCategoryOrTagIds = (title, categoryIds, tagIds) => {
  if (!title || title.length === 0) return;

  const category = categories.find((c) => c.title === title);
  if (category && category.id) {
    categoryIds.push(category.id);
  } else {
    const tag = tags.find((c) => c.title === title);
    if (tag && tag.id) tagIds.push(tag.id);
  }
};

const turndownService = new TurndownService();


const parseMetas = wpMetas => {
  //get metas as an array of key-value pairs
  const array = (wpMetas || []).map(meta=>{
    const key = _get(meta, ["wp:meta_key", "__cdata"]);
    let value = _get(meta, ["wp:meta_value", "__cdata"]);

    //maybe unserialize
    try{
      value = phpUnserialize(value);
    }catch(e){}

    //maybe parse JSON
    try{
      value = JSON.parse(value);
    }catch(e){}

    return {[key]:value}
  })

  //convert metas array to an object
  const object = array.reduce((acc, obj) => {
    const [key] = Object.keys(obj);
    const value = obj[key];

    if (acc.hasOwnProperty(key)) {
      if (Array.isArray(acc[key])) {
        acc[key].push(value);
      } else {
        acc[key] = [acc[key], value];
      }
    } else {
      acc[key] = value;
    }

    return acc;
  }, {});

  return object;
}

const getPosts = (postType) => {
  return (_get(otherProps, "item") || [])
    .filter((item) => _get(item, ["wp:post_type", "__cdata"]) === postType)
    .map((item) => {
      const author = authors.find(
        (a) => a.login === _get(item, ["dc:creator", "__cdata"])
      );
      const parentId = _get(item, "wp:post_parent");
      const postCategoryElement = _get(item, "category");
      const categoryIds = [];
      const tagIds = [];

      if (postCategoryElement) {
        if (Array.isArray(postCategoryElement)) {
          postCategoryElement.forEach((pc) => {
            if (pc.__cdata)
              populateCategoryOrTagIds(pc.__cdata, categoryIds, tagIds);
          });
        } else {
          populateCategoryOrTagIds(
            _get(item, ["category", "__cdata"]),
            categoryIds,
            tagIds
          );
        }
      }

      let markdown = null;
      let urls = [];
      const encodedContent = _get(item, ["content:encoded", "__cdata"]);
      if (encodedContent && encodedContent.length > 0) {
        markdown = turndownService.turndown(encodedContent);
        urls = htmlUrls({ html: encodedContent, removeDuplicates: true }).map(
          (r) => r.url
        );
      }

      let comments = null;
      const wpc = _get(item, "wp:comment", []);
      if (wpc && wpc.length > 0) {
        comments = [];
        wpc.forEach((c) => {
          const commentDateStr = _get(item, ["wp:post_date", "__cdata"], null);
          const commentDateGmtStr = _get(
            item,
            ["wp:post_date_gmt", "__cdata"],
            null
          );
          const commentDate =
            commentDateGmtStr && commentDateGmtStr.length > 0
              ? moment.utc(commentDateGmtStr).toISOString()
              : commentDateStr && commentDateStr.length > 0
              ? moment(commentDateStr).utc().toISOString()
              : null;
          comments.push({
            id: _get(c, "wp:comment_id"),
            author: nullIfEmpty(_get(c, ["wp:comment_author", "__cdata"])),
            authorEmail: nullIfEmpty(
              _get(c, ["wp:comment_author_email", "__cdata"])
            ),
            authorUrl: nullIfEmpty(
              _get(c, ["wp:comment_author_url", "__cdata"])
            ),
            authorIp: nullIfEmpty(_get(c, ["wp:comment_author_IP", "__cdata"])),
            date: commentDate,
            content: nullIfEmpty(_get(c, ["wp:comment_content", "__cdata"])),
            approved:
              parseInt(_get(c, ["wp:comment_approved", "__cdata"], "0")) === 1,
            type: nullIfEmpty(_get(c, ["wp:comment_type", "__cdata"])),
            parentId: _get(c, ["wp:comment_parent"]),
            userId: _get(c, ["wp:comment_user_id"]),
          });
        });
      }

      const pubDateStr = _get(item, "pubDate", null);
      const postDateStr = _get(item, ["wp:post_date", "__cdata"], null);
      const postDateGmtStr = _get(item, ["wp:post_date_gmt", "__cdata"], null);
      const postDate =
        postDateGmtStr && postDateGmtStr.length > 0
          ? moment.utc(postDateGmtStr).toISOString()
          : postDateStr && postDateStr.length > 0
          ? moment(postDateStr).utc().toISOString()
          : null;

      return {
        id: _get(item, "wp:post_id"),
        parentId,
        title: _get(item, "title"),
        slug: _get(item, ["wp:post_name", "__cdata"]),
        link: _get(item, "link"),
        guid: _get(item, "guid"),
        status: _get(item, ["wp:status", "__cdata"]),
        postDate,
        pubDate: pubDateStr && pubDateStr.length > 0 ? postDate : null,
        creator: _get(item, ["dc:creator", "__cdata"]),
        creatorId: author && author.id ? author.id : null,
        markdown,
        urls,
        encodedContent: encodedContent,
        encodedExcerpt: _get(item, ["excerpt:encoded", "__cdata"]),
        attachmentUrl: _get(item, ["wp:attachment_url", "__cdata"]),
        menuOrder: _get(item, ["wp:menu_order", "__cdata"]),
        categoryIds,
        tagIds,
        comments,
        metas:parseMetas(_get(item, "wp:postmeta"))
      };
    });
};

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
fso(path.join(outputDir, "site.json"), site);
fso(path.join(outputDir, "authors.json"), authors);
fso(path.join(outputDir, "categories.json"), categories);
fso(path.join(outputDir, "tags.json"), tags);
const postsDir = path.join(outputDir, "posts");
if (!fs.existsSync(postsDir)) fs.mkdirSync(postsDir, { recursive: true });
site.postTypes.forEach((postType) => {
  const posts = getPosts(postType);

  posts.forEach((p) => {
    if (!p.urls) return;

    if (p && p.guid && !allUrls.includes(p.guid)) allUrls.push(p.guid);

    if (p && p.attachmentUrl && !allUrls.includes(p.attachmentUrl))
      allUrls.push(p.attachmentUrl);

    p.urls.forEach((u) => {
      if (u && !allUrls.includes(u)) {
        allUrls.push(u);
      }
    });
  });

  fso(path.join(postsDir, `${postType}_collection.json`), posts);
  if (postType === "post") {
    const postsContentDir = path.join(postsDir, "posts_content");
    if (!fs.existsSync(postsContentDir))
      fs.mkdirSync(postsContentDir, { recursive: true });
    posts.forEach((p) => {
      if (p.markdown && p.markdown.length > 0) {
        fso(
          path.join(postsContentDir, `${p.id}${p.slug ? "-" + p.slug : ""}.md`),
          `
---
title:      ${p.title}
slug:       ${p.slug}
date:       ${p.postDate}
status:     ${p.status}
published:  ${p.pubDate}
---

${p.markdown}
`.trim()
        );
      }
    });
  }
});

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const allImages = {};
allUrls.forEach((u) => {
  const wpUploadBase = site.baseUrl + "/wp-content/uploads/";
  if (
    u.length <= wpUploadBase.length ||
    u.substring(0, wpUploadBase.length) !== wpUploadBase
  )
    return;
  if (
    !isImageUrl(u) &&
    !u.includes(".pdf") &&
    !u.includes(".doc") &&
    !u.includes(".docx") &&
    !u.includes(".xls") &&
    !u.includes(".xlsx")
  )
    return;

  const localImage = u.substring(wpUploadBase.length);
  allImages[u] = localImage;
});

fso(path.join(uploadsDir, "manifest.json"), { allImages, allUrls });

console.log("Downloading images");
async function downloadImages() {
  for (const imgUrl in allImages) {
    if (allImages.hasOwnProperty(imgUrl)) {
      const localImage = allImages[imgUrl];
      const localImagePath = path.join(uploadsDir, localImage);
      if (!fs.existsSync(localImagePath)) {
        const localImageDir = path.dirname(localImagePath);
        try {
          fs.mkdirSync(localImageDir, { recursive: true });
          const { filename } = await download.image({
            url: imgUrl,
            dest: localImagePath,
          });
          console.log(`  Image downloaded: ${filename}`);
        } catch (e) {
          console.error(`  Download error: ${e.message}`);
          if (e.message.indexOf("404") > -1) {
            const pl = `images/placeholder${path.extname(localImagePath)}`;
            console.log(
              `    Copying placeholder from ${pl} to ${localImagePath}`
            );
            fs.copyFileSync(pl, localImagePath);
          }
        }
      }
    }
  }
  console.log("  Images all downloaded");
}
downloadImages();
