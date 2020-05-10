const axios = require("axios");
const fs = require("fs");
const path = require("path");
const moment = require("moment");
const escapeRegExp = require("escape-string-regexp");
const FormData = require("form-data");
const needle = require("needle");
const mime = require("mime-types");

require("dotenv").config();

let _axios = null;
const strapiUrl = process.env.STRAPI_URL || "http://localhost:1337";

const site = JSON.parse(fs.readFileSync("./wp-export/site.json", "utf8"));
const wpCategories = JSON.parse(
  fs.readFileSync("./wp-export/categories.json", "utf8")
);
const wpTags = JSON.parse(fs.readFileSync("./wp-export/tags.json", "utf8"));
const wpAuthors = JSON.parse(
  fs.readFileSync("./wp-export/authors.json", "utf8")
);
const wpPosts = JSON.parse(
  fs.readFileSync("./wp-export/posts/post_collection.json", "utf8")
);
const wpAttachments = JSON.parse(
  fs.readFileSync("./wp-export/posts/attachment_collection.json", "utf8")
);
const manifest = JSON.parse(
  fs.readFileSync("./wp-export/uploads/manifest.json", "utf8")
);
String.prototype.replaceAll = function (searchStr, replaceStr) {
  // in 1 pass
  return this.replace(new RegExp(escapeRegExp(searchStr), "gi"), replaceStr);
  // could also do it with recursion
  // var str = this;
  // if (str.indexOf(searchStr) === -1) {
  //   return str;
  // }
  // return str.replace(searchStr, replaceStr).replaceAll(searchStr, replaceStr);
};

// this function from: https://medium.com/@mhagemann/the-ultimate-way-to-slugify-a-url-string-in-javascript-b8e4a0d849e1
const slugify = (string) => {
  const a =
    "àáâäæãåāăąçćčđďèéêëēėęěğǵḧîïíīįìłḿñńǹňôöòóœøōõőṕŕřßśšşșťțûüùúūǘůűųẃẍÿýžźż·/_,:;";
  const b =
    "aaaaaaaaaacccddeeeeeeeegghiiiiiilmnnnnoooooooooprrsssssttuuuuuuuuuwxyyzzz------";
  const p = new RegExp(a.split("").join("|"), "g");

  return string
    .toString()
    .toLowerCase()
    .replace(/\s+/g, "-") // Replace spaces with -
    .replace(p, (c) => b.charAt(a.indexOf(c))) // Replace special characters
    .replace(/&/g, "-and-") // Replace & with 'and'
    .replace(/[^\w\-]+/g, "") // Remove all non-word characters
    .replace(/\-\-+/g, "-") // Replace multiple - with single -
    .replace(/^-+/, "") // Trim - from start of text
    .replace(/-+$/, ""); // Trim - from end of text
};

const _upload = async (file, name, caption, alternativeText) => {
  try {
    const data = {
      fileInfo: JSON.stringify({
        alternativeText,
        caption,
        name,
      }),
      files: {
        file,
        content_type: mime.contentType(file),
      },
    };
    const { body } = await needle("post", strapiUrl + "/upload", data, {
      multipart: true,
      headers: {
        authorization: _axios.defaults.headers.Authorization,
      },
    });
    return Array.isArray(body) ? (body.length > 0 ? body[0] : null) : body;
  } catch (e) {
    console.error(e.message);
    return null;
  }
};

const _delete = async (r) => {
  try {
    const { data } = await _axios.delete(r);
    return data;
  } catch (e) {
    console.error(e.message);
    throw e;
  }
};

const _post = async (r, obj) => {
  try {
    const { data } = await _axios.post(r, obj);
    return data;
  } catch (e) {
    console.error(e.message);
    console.error(JSON.stringify(obj));
    throw e;
  }
};

const _put = async (r, obj) => {
  try {
    const { data } = await _axios.put(r, obj);
    return data;
  } catch (e) {
    console.error(e.message);
    console.error(JSON.stringify(obj));
    throw e;
  }
};

let defaultUser = null;
let users = [];
const authenticate = async () => {
  try {
    const { data } = await axios.post(strapiUrl + "/admin/auth/local", {
      identifier: process.env.STRAPI_USERNAME,
      password: process.env.STRAPI_PASSWORD,
    });
    const { jwt } = data;
    _axios = axios.create({
      baseURL: strapiUrl,
      timeout: 1000,
      headers: { Authorization: "Bearer " + jwt },
    });
    users = (await _axios.get("/users?_limit=1")).data;
    defaultUser =
      process.env.STRAPI_POSTS_DEFAULTUSER &&
      process.env.STRAPI_POSTS_DEFAULTUSER.length > 0
        ? users.find((u) => u.username === process.env.STRAPI_POSTS_DEFAULTUSER)
        : null;
    console.log("Authenticated");
  } catch (e) {
    console.error(e);
    throw e;
  }
};

const importTags = async () => {
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++
  // import tags
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++
  const existingTags = (await _axios.get("/tags?_limit=-1")).data;
  console.log(`Attempting to import ${wpTags.length} tags`);
  let newTags = 0,
    dupeTags = 0;
  for (let wpTagIndex = 0; wpTagIndex < wpTags.length; wpTagIndex++) {
    const wpTag = wpTags[wpTagIndex];
    if (
      existingTags.findIndex(
        (t) => t.slug.toLowerCase() === wpTag.slug.toLowerCase()
      ) === -1
    ) {
      await _post("/tags", {
        slug: wpTag.slug,
        title: wpTag.title,
      });
      newTags++;
    } else {
      dupeTags++;
    }
  }
  console.log(
    `  Imported ${newTags} new tags, found ${dupeTags} existing tags`
  );
};

const importCategories = async () => {
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++
  // import categories
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++
  let existingCategories = (await _axios.get("/categories?_limit=-1")).data;
  console.log(`Attempting to import ${wpCategories.length} categories`);
  let newCategories = 0,
    dupeCategories = 0;
  // first pass, add the categories without the parent/child relationships
  for (
    let wpCategoryIndex = 0;
    wpCategoryIndex < wpCategories.length;
    wpCategoryIndex++
  ) {
    const wpCategory = wpCategories[wpCategoryIndex];
    if (
      existingCategories.findIndex(
        (t) => t.slug.toLowerCase() === wpCategory.slug.toLowerCase()
      ) === -1
    ) {
      await _post("/categories", {
        slug: wpCategory.slug,
        title: wpCategory.title,
      });
      newCategories++;
    } else {
      dupeCategories++;
    }
  }
  console.log(
    `  Imported ${newCategories} new categories, found ${dupeCategories} existing categories`
  );
  existingCategories = (await _axios.get("/categories?_limit=-1")).data;
  var wpCategoriesWithParents = wpCategories
    .filter((c) => c.parentId && c.parentId > 0)
    .map((c) => {
      return {
        ...c,
        parentSlug: wpCategories.find((p) => p.id === c.parentId).slug,
      };
    });
  // second pass, updatet the parent/child relationships
  let updatedCategories = 0;
  let alreadyHadParents = 0;
  for (
    let wpCategoryIndex = 0;
    wpCategoryIndex < wpCategoriesWithParents.length;
    wpCategoryIndex++
  ) {
    const wpCategory = wpCategoriesWithParents[wpCategoryIndex];
    const existingCategory = existingCategories.find(
      (e) => e.slug === wpCategory.slug
    );
    if (existingCategory && !existingCategory.parent) {
      const parentCategory = existingCategories.find(
        (e) => e.slug === wpCategory.parentSlug
      );
      if (parentCategory) {
        existingCategory.parent = {
          id: parentCategory.id,
        };
        await _put(`/categories/${existingCategory.id}`, existingCategory);
        updatedCategories++;
      }
    } else if (existingCategory && existingCategory.parent) {
      alreadyHadParents++;
    }
  }
  console.log(
    `  Updated ${updatedCategories} categories with parent relationships, ${alreadyHadParents} already had parents assigned`
  );
};

const importPosts = async (doUpdates) => {
  let missingUsers = [];
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++
  // import posts
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++
  let existingPosts = (await _axios.get("/posts?_limit=-1")).data;
  const urlSubstitutions = {};
  wpPosts.forEach((p) => {
    const dtUrl =
      p.postDate && p.postDate.length
        ? moment.utc(p.postDate).format("YYYY/MM/DD")
        : null;
    if (!p.slug || p.slug.length === 0) p.slug = slugify(p.title);
    if (p.link && p.link.length) {
      if (dtUrl) {
        urlSubstitutions[
          `${site.baseUrl}/${dtUrl}/${p.slug}/`
        ] = `/blog/${p.slug}`;
        urlSubstitutions[
          `${site.baseUrl}/${dtUrl}/${p.slug}/`
        ] = `/blog/${p.slug}`;
      }
      urlSubstitutions[p.link] = `/blog/${p.slug}`;
    }
  });
  console.log(`Attempting to import ${wpPosts.length} posts`);
  let newPosts = 0,
    dupePosts = 0;
  for (let wpPostIndex = 0; wpPostIndex < wpPosts.length; wpPostIndex++) {
    const wpPost = wpPosts[wpPostIndex];
    if (!wpPost.title) continue;
    const existing = existingPosts.find(
      (t) => t.slug.toLowerCase() === wpPost.slug.toLowerCase()
    );
    const publish_date =
      wpPost.pubDate && wpPost.pubDate.length > 0
        ? moment.utc(wpPost.pubDate).toISOString()
        : null;
    const original_date =
      wpPost.postDate && wpPost.postDate.length > 0
        ? moment(wpPost.postDate).toISOString()
        : null;
    let markdown = wpPost.markdown || "";
    let excerpt = wpPost.encodedExcerpt || "";
    wpPost.urls.forEach((url) => {
      if (urlSubstitutions[url]) {
        markdown = markdown.replaceAll(url, urlSubstitutions[url]);
        excerpt = excerpt.replaceAll(url, urlSubstitutions[url]);
      }
    });
    const user =
      users.find((u) => u.username === wpPost.creator) || defaultUser;
    if (!existing) {
      if (user) {
        await _post("/posts", {
          slug: wpPost.slug,
          title: wpPost.title,
          body: markdown,
          excerpt: excerpt,
          publish_date,
          published: wpPost.status === "publish",
          author: { id: user.id },
          original_date,
          wp_id: wpPost.id,
        });
        newPosts++;
      } else {
        missingUsers.push(wpPost.creator);
      }
    } else {
      // update post
      if (user) {
        existing.title = wpPost.title;
        existing.body = markdown;
        existing.excerpt = excerpt;
        existing.original_date = original_date;
        existing.publish_date = publish_date;
        existing.published = wpPost.status === "publish";
        existing.wp_id = wpPost.id;
        if (doUpdates) await _put(`/posts/${existing.id}`, existing);
      }
      dupePosts++;
    }
  }
  if (missingUsers.length > 0) {
    console.log(
      `  Unable to import posts due to ${missingUsers.length} missing users: `,
      new Set(missingUsers).values()
    );
  }
  console.log(
    `  Imported ${newPosts} new posts, updated ${dupePosts} existing posts`
  );
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++
  // update post tags & categories
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++
  existingPosts = (await _axios.get("/posts?_limit=-1")).data;
  const categories = (await _axios.get("/categories?_limit=-1")).data;
  const wpCategories = JSON.parse(
    fs.readFileSync("./wp-export/categories.json", "utf8")
  );
  const tags = (await _axios.get("/tags?_limit=-1")).data;
  const wpTags = JSON.parse(fs.readFileSync("./wp-export/tags.json", "utf8"));
  let updatedPosts = 0;
  for (let wpPostIndex = 0; wpPostIndex < wpPosts.length; wpPostIndex++) {
    const wpPost = wpPosts[wpPostIndex];
    if (!wpPost.title) continue;
    if (!wpPost.slug || wpPost.slug.length === 0)
      wpPost.slug = slugify(wpPost.title);
    const existing = existingPosts.find(
      (t) => t.slug.toLowerCase() === wpPost.slug.toLowerCase()
    );
    const catIds = [];
    const tagIds = [];
    if (
      existing &&
      (!existing.categories || existing.categories.length === 0) &&
      wpPost.categoryIds &&
      wpPost.categoryIds.length > 0
    ) {
      for (let ci = 0; ci < wpPost.categoryIds.length; ci++) {
        const wpCatSlug = (
          wpCategories.find((g) => g.id === wpPost.categoryIds[ci]) || {}
        ).slug;
        if (wpCatSlug) {
          const cat = categories.find((s) => wpCatSlug === s.slug);
          if (cat && cat.id) catIds.push(cat.id);
        }
      }
    }
    if (
      existing &&
      (!existing.tags || existing.tags.length === 0) &&
      wpPost.tagIds &&
      wpPost.tagIds.length > 0
    ) {
      for (let ci = 0; ci < wpPost.tagIds.length; ci++) {
        const wpTagSlug = (wpTags.find((g) => g.id === wpPost.tagIds[ci]) || {})
          .slug;
        if (wpTagSlug) {
          const tag = tags.find((s) => wpTagSlug === s.slug);
          if (tag && tag.id) tagIds.push(tag.id);
        }
      }
    }
    if (catIds.length) {
      existing.categories = catIds.map((id) => {
        return { id };
      });
    }
    if (tagIds.length) {
      existing.tags = tagIds.map((id) => {
        return { id };
      });
    }
    if (catIds.length || tagIds.length) {
      await _put("/posts/" + existing.id, existing);
      updatedPosts++;
    }
  }
  console.log(`  Updated ${updatedPosts} posts with tags and categories`);
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++
  // update post comments
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++
  const existingComments = (await _axios.get("/comments?_limit=-1")).data;
  // drop all existing comments
  // for (let di = 0; di < existingComments.length; di++) {
  //   const dicm = existingComments[di];
  //   console.log("Deleting comment " + dicm.id);
  //   await _delete(`/comments/${dicm.id}`);
  // }

  let commentsCount = 0;
  for (let wpPostIndex = 0; wpPostIndex < wpPosts.length; wpPostIndex++) {
    const wpPost = wpPosts[wpPostIndex];
    if (!wpPost.title) continue;
    if (!wpPost.slug || wpPost.slug.length === 0)
      wpPost.slug = slugify(wpPost.title);
    const existing = existingPosts.find(
      (t) => t.slug.toLowerCase() === wpPost.slug.toLowerCase()
    );
    if (!existing || !wpPost.comments || wpPost.comments.length === 0) continue;

    // does the post have comments
    if (
      existingComments.findIndex((c) => c.post && c.post.id === existing.id) >
      -1
    ) {
      continue; // no need to populate comments if they were already populated
    }
    const sComments = {};
    // assumes that the list is in such an order where comments with parents always
    // appear AFTER the parent comment itself in the enumeration
    const lenWpComments = wpPost.comments.length;
    for (let ci = 0; ci < lenWpComments; ci++) {
      const wpComment = wpPost.comments[ci];
      let user = null;
      if (wpComment.userId && wpComment.userId > 0) {
        const wpAuthor = wpAuthors.find((a) => a.id === wpComment.userId);
        if (wpAuthor && wpAuthor.id > 0) {
          const eUser =
            users.find((u) => u.username === wpAuthor.login) || defaultUser;
          if (eUser) user = { id: eUser.id };
        }
      }
      const parent =
        wpComment.parentId && wpComment.parentId > 0
          ? sComments[`c-${wpComment.parentId}`]
          : null;
      let newComment = {
        author: wpComment.author,
        author_email: wpComment.authorEmail,
        author_url: wpComment.authorUrl,
        author_ip: wpComment.authorIp,
        approved: wpComment.approved,
        comment_type: wpComment.type,
        comment_date: wpComment.date,
        body: wpComment.content,
        parent,
        post: { id: existing.id },
        user,
      };
      newComment = await _post("/comments", newComment);
      console.log(newComment);
      sComments[`c-${wpComment.id}`] = { id: newComment.id };
      commentsCount++;
    }
  }
  console.log(`  Added ${commentsCount} post comments`);
};

const uploadMedia = async () => {
  const existingPosts = (await _axios.get("/posts?_limit=-1")).data;
  const existingFiles = (await _axios.get("/upload/files?_limit=-1")).data;
  const allMedia = manifest.allImages;
  console.log(
    `Attempting to upload ${Object.keys(allMedia).length} media files`
  );
  let uploads = 0;
  let exists = 0;
  const urlToExistingFileMap = {};
  for (const key in allMedia) {
    if (allMedia.hasOwnProperty(key)) {
      const file = path.join("./wp-export/uploads/", allMedia[key]);
      const fileName = slugify(path.parse(allMedia[key]).name);
      let existingFile = existingFiles.find((f) => f.name === fileName);
      if (!existingFile) {
        console.log(`Uploading file ${file}`);
        existingFile = await _upload(file, fileName);
        existingFiles.push(newFile);
        uploads++;
      } else {
        exists++;
      }
      urlToExistingFileMap[key] = existingFile;
    }
  }
  console.log(`  ${uploads} files uploaded, ${exists} previously uploaded`);

  let featureImageUpdates = 0;
  let postUpdates = 0;
  for (let wpPostIndex = 0; wpPostIndex < wpPosts.length; wpPostIndex++) {
    const wpPost = wpPosts[wpPostIndex];
    const existing = existingPosts.find((t) => t.wp_id === wpPost.id);
    if (!existing) continue;

    let hasUpdate = false;
    const attachments = wpAttachments.filter(
      (f) => f.parentId === existing.wp_id
    );
    if (attachments && attachments.length > 0) {
      for (let ai = 0; ai < attachments.length; ai++) {
        const url = attachments[ai].attachmentUrl;
        if (url && allMedia[url] && urlToExistingFileMap[url]) {
          if (existing.feature_image == null) {
            existing.feature_image = { id: urlToExistingFileMap[url].id };
            featureImageUpdates++;
            hasUpdate = true;
            break;
          }
        }
      }
    }

    for (let ui = 0; ui < wpPost.urls.length; ui++) {
      const url = wpPost.urls[ui];
      if (allMedia[url] && urlToExistingFileMap[url]) {
        const previousBody = existing.body;
        existing.body = existing.body.replaceAll(
          url,
          urlToExistingFileMap[url].url
        );
        if (previousBody.length !== existing.body.length) hasUpdate = true;
      }
    }

    if (hasUpdate) {
      await _put(`/posts/${existing.id}`, existing);
      postUpdates++;
    }
  }
  console.log(
    `  ${postUpdates} image updates, of which ${featureImageUpdates} had feature image updates`
  );
};

const run = async () => {
  await authenticate();
  await importTags();
  await importCategories();
  await importPosts(false); // change to `true` to reset post content from wp
  await uploadMedia();
};
run();
