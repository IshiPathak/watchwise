
(() => {
  "use strict";

  if (window.__WATCHWISE_V9__) return;
  window.__WATCHWISE_V9__ = true;

  // SETTINGS
  const SAMPLE_SIZE = 200;
  const MAX_PAGES = 500;
  const PAGE_DELAY = 300;
  const RENDER_EVERY = 2;

  let videos = new Map();
  let categories = [];
  let vocabulary = new Map();
  let continuation = null;
  let clickTrackingParams = null;
  let selectedCategory = "All";
  let nativePlaylist = null;
  let fullLoaded = false;
  let loading = false;
  let loadError = null;
  let stopped = false;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const STOP_WORDS = new Set(`
    the and for with from into about your this that what when
    where why how are was were you all can will just have has
    its our their they them then than but not now new best
    full complete official tutorial course guide video videos
    watch part episode beginner beginners advanced explained
    learn learning introduction shorts short make made using
    everything something really very more most only also
    my me i we he she it a an to of in on at by as is be
    do did does if or so up out over after before
    please like subscribe channel playlist youtube
    day days week weeks hour hours
  `.trim().split(/\s+/));

  function isWatchLater() {
    return new URLSearchParams(location.search).get("list") === "WL";
  }

  // --------------------------------
  // SAFE OBJECT SEARCH
  // --------------------------------

  function findAll(object, key, output = [], seen = new WeakSet()) {
    if (!object || typeof object !== "object" || seen.has(object)) {
      return output;
    }

    seen.add(object);

    if (Object.prototype.hasOwnProperty.call(object, key)) {
      output.push(object[key]);
    }

    for (const value of Object.values(object)) {
      if (value && typeof value === "object") {
        findAll(value, key, output, seen);
      }
    }

    return output;
  }

  function getText(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (value.simpleText) return value.simpleText;
    if (typeof value.content === "string") return value.content;

    if (value.runs) {
      return value.runs.map(x => x.text || "").join("");
    }

    return "";
  }

  // --------------------------------
  // VIDEO EXTRACTION
  // --------------------------------

  function addVideoData(id, title, thumbnail, duration) {
    if (!id || !title || videos.has(id)) return;

    videos.set(id, {
      id,
      title,
      thumbnail: thumbnail ||
        `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      duration: duration || "",
      url: `https://www.youtube.com/watch?v=${id}`,
      category: "Other"
    });
  }

  function addOldVideo(renderer) {
    if (!renderer) return;

    const id = renderer.videoId;
    const title = getText(renderer.title).trim();

    if (!id || !title) return;

    const thumbs = renderer.thumbnail?.thumbnails || [];

    const thumbnail = thumbs.length
      ? thumbs[thumbs.length - 1].url
      : "";

    const duration =
      getText(renderer.lengthText) ||
      getText(
        renderer.thumbnailOverlays?.find(
          x => x.thumbnailOverlayTimeStatusRenderer
        )?.thumbnailOverlayTimeStatusRenderer?.text
      );

    addVideoData(id, title, thumbnail, duration);
  }

  function addLockupVideo(lockup) {
    if (!lockup) return;

    const id =
      lockup.contentId ||
      lockup.videoId ||
      lockup.content_id;

    const metadata = lockup.metadata?.lockupMetadataViewModel;

    const title =
      getText(metadata?.title) ||
      getText(lockup.title) ||
      getText(lockup.accessibilityText);

    if (!id || !title) return;

    const thumbnailSources = findAll(
      lockup.contentImage || {},
      "url"
    );

    const thumbnail =
      thumbnailSources
        .filter(url =>
          typeof url === "string" &&
          url.startsWith("http")
        )
        .at(-1) || "";

    const badges = findAll(
      lockup.contentImage || {},
      "thumbnailBadgeViewModel"
    );

    let duration = "";

    for (const badge of badges) {
      const text = getText(badge.text);

      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) {
        duration = text;
        break;
      }
    }

    if (!duration) {
      const overlays = findAll(
        lockup,
        "thumbnailOverlayTimeStatusRenderer"
      );

      for (const overlay of overlays) {
        const text = getText(overlay?.text);
        if (text) {
          duration = text;
          break;
        }
      }
    }

    addVideoData(id, title, thumbnail, duration);
  }

  function extractVideoFromItem(item) {
    if (!item || typeof item !== "object") return;

    if (item.playlistVideoRenderer) {
      addOldVideo(item.playlistVideoRenderer);
    }

    if (item.lockupViewModel) {
      addLockupVideo(item.lockupViewModel);
    }

    if (item.richItemRenderer?.content) {
      extractVideoFromItem(item.richItemRenderer.content);
    }

    if (item.itemSectionRenderer?.contents) {
      extractVideosFromItems(item.itemSectionRenderer.contents);
    }
  }

  function extractVideosFromItems(items) {
    if (!Array.isArray(items)) return 0;

    const before = videos.size;

    for (const item of items) {
      extractVideoFromItem(item);
    }

    return videos.size - before;
  }

  // --------------------------------
  // CONTINUATION TOKEN EXTRACTION
  // --------------------------------

  function tokenFromContinuationItem(item) {
    if (!item || typeof item !== "object") return null;

    // Older YouTube continuation renderer.
    const oldRenderer = item.continuationItemRenderer;

    if (oldRenderer) {
      const endpoint = oldRenderer.continuationEndpoint;

      // Actual format found in your console:
      // endpoint.commandExecutorCommand.commands[].continuationCommand.token

      const commands =
        endpoint?.commandExecutorCommand?.commands || [];

      for (const commandItem of commands) {
        const command = commandItem?.continuationCommand;

        if (command?.token) {
          return {
            token: command.token,
            clickTrackingParams:
              endpoint?.clickTrackingParams || null
          };
        }
      }

      // Other older formats.
      const directToken =
        endpoint?.continuationCommand?.token ||
        endpoint?.command?.continuationCommand?.token;

      if (directToken) {
        return {
          token: directToken,
          clickTrackingParams:
            endpoint?.clickTrackingParams || null
        };
      }

      if (endpoint) {
        const nestedCommands = findAll(
          endpoint,
          "continuationCommand"
        );

        for (const command of nestedCommands) {
          if (command?.token) {
            return {
              token: command.token,
              clickTrackingParams:
                endpoint.clickTrackingParams || null
            };
          }
        }
      }
    }

    // Newer continuationItemViewModel format.
    const model = item.continuationItemViewModel;

    if (model) {
      const command = model.continuationCommand;

      const nested =
        command?.innertubeCommand?.continuationCommand;

      if (nested?.token) {
        return {
          token: nested.token,
          clickTrackingParams:
            command?.innertubeCommand?.clickTrackingParams ||
            command?.clickTrackingParams ||
            model.clickTrackingParams ||
            null
        };
      }

      if (command?.token) {
        return {
          token: command.token,
          clickTrackingParams:
            model.clickTrackingParams || null
        };
      }

      const nestedCommands = findAll(
        model,
        "continuationCommand"
      );

      for (const candidate of nestedCommands) {
        if (candidate?.token) {
          return {
            token: candidate.token,
            clickTrackingParams:
              model.clickTrackingParams || null
          };
        }
      }
    }

    return null;
  }

  function continuationFromItems(items) {
    if (!Array.isArray(items)) return null;

    for (let i = items.length - 1; i >= 0; i--) {
      const result = tokenFromContinuationItem(items[i]);
      if (result) return result;
    }

    return null;
  }

  function extractOldPlaylist(data) {
    const lists = findAll(data, "playlistVideoListRenderer");

    for (const playlist of lists) {
      if (!Array.isArray(playlist?.contents)) continue;

      const before = videos.size;
      extractVideosFromItems(playlist.contents);

      if (videos.size > before || playlist.contents.length) {
        const next = continuationFromItems(playlist.contents);

        if (next) return next;

        if (playlist.continuations?.length) {
          const oldToken =
            playlist.continuations[0]
              ?.nextContinuationData?.continuation;

          if (oldToken) {
            return {
              token: oldToken,
              clickTrackingParams: null
            };
          }
        }

        return null;
      }
    }

    return null;
  }

  function extractNewPlaylist(data) {
    const sectionLists = findAll(data, "sectionListRenderer");

    for (const sectionList of sectionLists) {
      const sections = sectionList?.contents;

      if (!Array.isArray(sections)) continue;

      for (const section of sections) {
        const itemSection = section?.itemSectionRenderer;

        if (!itemSection || !Array.isArray(itemSection.contents)) {
          continue;
        }

        const items = itemSection.contents;
        const before = videos.size;

        extractVideosFromItems(items);

        if (videos.size === before) continue;

        return continuationFromItems(items);
      }
    }

    return null;
  }

  function readInitialPlaylist(data) {
    let next = extractOldPlaylist(data);

    if (!next) {
      next = extractNewPlaylist(data);
    }

    if (next) {
      continuation = next.token;
      clickTrackingParams = next.clickTrackingParams;
    }

    console.log("WatchWise initial videos:", videos.size);
    console.log(
      "WatchWise playlist continuation:",
      Boolean(continuation)
    );

    return videos.size > 0;
  }

  // --------------------------------
  // AUTHENTICATION
  // --------------------------------

  function getCookie(name) {
    const prefix = `${name}=`;
    const entry = document.cookie
      .split(";")
      .map(part => part.trim())
      .find(part => part.startsWith(prefix));

    if (!entry) return null;

    return decodeURIComponent(entry.slice(prefix.length));
  }

  async function sha1Hex(value) {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-1", data);

    return [...new Uint8Array(digest)]
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function getYouTubeAuthHeaders(config) {
    const origin = location.origin;
    const timestamp = Math.floor(Date.now() / 1000);

    const cookieTypes = [
      ["SAPISID", "SAPISIDHASH"],
      ["__Secure-1PAPISID", "SAPISID1PHASH"],
      ["__Secure-3PAPISID", "SAPISID3PHASH"]
    ];

    const authorizationParts = [];

    for (const [cookieName, scheme] of cookieTypes) {
      const cookieValue = getCookie(cookieName);

      if (!cookieValue) continue;

      const hash = await sha1Hex(
        `${timestamp} ${cookieValue} ${origin}`
      );

      authorizationParts.push(
        `${scheme} ${timestamp}_${hash}`
      );
    }

    if (!authorizationParts.length) {
      throw new Error(
        "YouTube authentication cookie was not accessible. " +
        "Refresh YouTube and check that you are signed in."
      );
    }

    const headers = {
      "Authorization": authorizationParts.join(" "),
      "X-Goog-AuthUser": String(config.sessionIndex ?? 0),
      "X-Origin": origin,
      "X-Youtube-Bootstrap-Logged-In": "true"
    };

    if (config.delegatedSessionId) {
      headers["X-Goog-PageId"] = config.delegatedSessionId;
    }

    return headers;
  }

  // --------------------------------
  // CONTINUATION RESPONSE EXTRACTION
  // --------------------------------

  function getContinuationItems(data) {
    const appendActions = findAll(
      data,
      "appendContinuationItemsAction"
    );

    for (let i = appendActions.length - 1; i >= 0; i--) {
      const items = appendActions[i]?.continuationItems;
      if (Array.isArray(items)) return items;
    }

    const reloadCommands = findAll(
      data,
      "reloadContinuationItemsCommand"
    );

    for (let i = reloadCommands.length - 1; i >= 0; i--) {
      const items = reloadCommands[i]?.continuationItems;
      if (Array.isArray(items)) return items;
    }

    const oldLists = findAll(
      data,
      "playlistVideoListContinuation"
    );

    for (const list of oldLists) {
      if (Array.isArray(list?.contents)) {
        return list.contents;
      }
    }

    const sectionContinuations = findAll(
      data,
      "itemSectionContinuation"
    );

    for (const section of sectionContinuations) {
      if (Array.isArray(section?.contents)) {
        return section.contents;
      }
    }

    return null;
  }

  function getYouTubeError(data) {
    const alerts = findAll(data, "alertRenderer");

    for (const alert of alerts) {
      const message = getText(alert?.text);
      if (message) return message;
    }

    return null;
  }

  // --------------------------------
  // YOUTUBE CONFIGURATION
  // --------------------------------

  function getYouTubeConfig() {
    const config = window.ytcfg;

    if (!config?.get) {
      throw new Error("YouTube configuration is unavailable.");
    }

    const apiKey = config.get("INNERTUBE_API_KEY");
    const context = config.get("INNERTUBE_CONTEXT");

    if (!apiKey || !context) {
      throw new Error("YouTube API configuration is incomplete.");
    }

    return {
      apiKey,
      context,
      clientName: config.get("INNERTUBE_CLIENT_NAME") || 1,
      clientVersion: config.get("INNERTUBE_CLIENT_VERSION") || "",
      visitorData: config.get("VISITOR_DATA"),
      sessionIndex: config.get("SESSION_INDEX"),
      delegatedSessionId: config.get("DELEGATED_SESSION_ID")
    };
  }

  // --------------------------------
  // BACKGROUND PAGE REQUEST
  // --------------------------------

  async function fetchNextPage() {
    if (!continuation) return false;

    const config = getYouTubeConfig();
    const authHeaders = await getYouTubeAuthHeaders(config);

    const oldToken = continuation;
    const oldCount = videos.size;

    const endpoint =
      `/youtubei/v1/browse?prettyPrint=false&key=${encodeURIComponent(config.apiKey)}`;

    const headers = {
      "Content-Type": "application/json",
      "X-YouTube-Client-Name": String(config.clientName),
      "X-YouTube-Client-Version": config.clientVersion,
      ...authHeaders
    };

    if (config.visitorData) {
      headers["X-Goog-Visitor-Id"] = config.visitorData;
    }

    const body = {
      context: config.context,
      continuation: oldToken
    };

    if (clickTrackingParams) {
      body.clickTracking = {
        clickTrackingParams
      };
    }

    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers,
      body: JSON.stringify(body),
      referrer: location.href
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");

      throw new Error(
        `YouTube API returned HTTP ${response.status}: ` +
        responseText.slice(0, 250)
      );
    }

    const data = await response.json();

    // Surface YouTube's own error message instead of a generic parser error.
    const youtubeError = getYouTubeError(data);

    if (youtubeError) {
      console.error("WatchWise YouTube API error:", youtubeError, data);

      throw new Error(
        `YouTube rejected the continuation request: ${youtubeError}`
      );
    }

    const items = getContinuationItems(data);

    if (!items) {
      console.error(
        "WatchWise unexpected continuation response:",
        data
      );

      throw new Error(
        "YouTube returned an unfamiliar continuation response. " +
        "Open the console for details."
      );
    }

    const count = extractVideosFromItems(items);
    const next = continuationFromItems(items);

    if (count === 0) {
      console.error(
        "WatchWise received continuation items but found no playlist videos:",
        items
      );

      throw new Error(
        "YouTube returned a page without recognizable playlist videos."
      );
    }

    if (!next) {
      continuation = null;
      clickTrackingParams = null;
    } else if (next.token === oldToken) {
      throw new Error(
        "YouTube repeated a continuation token. Stopping to prevent an infinite loop."
      );
    } else {
      continuation = next.token;
      clickTrackingParams = next.clickTrackingParams;
    }

    console.log(
      "WatchWise page:",
      count,
      "new videos;",
      videos.size,
      "unique videos collected;",
      "next page:",
      Boolean(continuation)
    );

    return videos.size > oldCount;
  }

  // --------------------------------
  // DYNAMIC CATEGORY DISCOVERY
  // ORIGINAL ALGORITHM PRESERVED
  // --------------------------------

  function tokenize(title) {
    const words = title
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^\p{L}\p{N}+# ]/gu, " ")
      .split(/\s+/)
      .filter(word =>
        word.length > 2 &&
        !STOP_WORDS.has(word) &&
        !/^\d+$/.test(word)
      );

    const result = [...words];

    for (let i = 0; i < words.length - 1; i++) {
      result.push(`${words[i]}_${words[i + 1]}`);
    }

    return result;
  }

  function normalize(vector) {
    let magnitude = 0;

    for (const value of vector.values()) {
      magnitude += value * value;
    }

    magnitude = Math.sqrt(magnitude);

    if (magnitude) {
      for (const [key, value] of vector) {
        vector.set(key, value / magnitude);
      }
    }

    return vector;
  }

  function similarity(a, b) {
    let score = 0;

    a.forEach((value, key) => {
      score += value * (b.get(key) || 0);
    });

    return score;
  }

  function vectorize(title) {
    const counts = new Map();

    tokenize(title).forEach(word => {
      if (vocabulary.has(word)) {
        counts.set(word, (counts.get(word) || 0) + 1);
      }
    });

    const vector = new Map();

    counts.forEach((count, word) => {
      vector.set(
        word,
        (1 + Math.log(count)) * vocabulary.get(word)
      );
    });

    return normalize(vector);
  }

  function centroid(documents) {
    const result = new Map();

    documents.forEach(doc => {
      doc.vector.forEach((value, word) => {
        result.set(word, (result.get(word) || 0) + value);
      });
    });

    result.forEach((value, word) => {
      result.set(word, value / documents.length);
    });

    return normalize(result);
  }

  function discoverTopics(sample) {
    const frequency = new Map();

    sample.forEach(video => {
      new Set(tokenize(video.title)).forEach(word => {
        frequency.set(word, (frequency.get(word) || 0) + 1);
      });
    });

    vocabulary = new Map(
      [...frequency.entries()]
        .filter(([word, count]) =>
          count >= Math.max(2, Math.ceil(sample.length * 0.015)) &&
          count <= sample.length * 0.65
        )
        .map(([word, count]) => [
          word,
          Math.log(1 + sample.length / (1 + count))
        ])
    );

    const documents = sample.map(video => ({
      video,
      vector: vectorize(video.title)
    })).filter(doc => doc.vector.size);

    if (documents.length < 15) {
      throw new Error("Not enough video titles to discover topics.");
    }

    const k = Math.min(
      8,
      Math.max(5, Math.round(Math.sqrt(documents.length / 5))),
      Math.floor(documents.length / 4)
    );

    const centers = [documents[0].vector];

    while (centers.length < k) {
      let best = null;
      let distance = -1;

      documents.forEach(doc => {
        const closest = Math.max(
          ...centers.map(center => similarity(doc.vector, center))
        );

        if (1 - closest > distance) {
          distance = 1 - closest;
          best = doc.vector;
        }
      });

      if (!best) break;
      centers.push(best);
    }

    const assignments = new Array(documents.length).fill(-1);

    for (let iteration = 0; iteration < 25; iteration++) {
      let changed = false;

      documents.forEach((doc, index) => {
        let best = 0;
        let score = -1;

        centers.forEach((center, cluster) => {
          const current = similarity(doc.vector, center);

          if (current > score) {
            score = current;
            best = cluster;
          }
        });

        if (assignments[index] !== best) {
          assignments[index] = best;
          changed = true;
        }
      });

      centers.forEach((_, cluster) => {
        const members = documents.filter(
          (_, index) => assignments[index] === cluster
        );

        if (members.length) {
          centers[cluster] = centroid(members);
        }
      });

      if (!changed) break;
    }

    categories = [];

    centers.forEach((center, cluster) => {
      const members = documents.filter(
        (_, index) => assignments[index] === cluster
      );

      if (members.length < 4) return;

      const scores = new Map();

      members.forEach(doc => {
        doc.vector.forEach((value, word) => {
          scores.set(word, (scores.get(word) || 0) + value);
        });
      });

      const keywords = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([word]) => word.replace(/_/g, " "));

      if (!keywords.length) return;

      const name = keywords.map(word =>
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(" & ");

      categories.push({
        name,
        centroid: center
      });
    });

    const usedNames = new Set();

    categories.forEach(category => {
      const base = category.name;
      let name = base;
      let number = 2;

      while (usedNames.has(name)) {
        name = `${base} ${number++}`;
      }

      category.name = name;
      usedNames.add(name);
    });
  }

  function classifyVideos() {
    videos.forEach(video => {
      const vector = vectorize(video.title);

      let best = null;
      let bestScore = -1;

      categories.forEach(category => {
        const score = similarity(vector, category.centroid);

        if (score > bestScore) {
          bestScore = score;
          best = category;
        }
      });

      video.category =
        best && bestScore >= 0.10
          ? best.name
          : "Other";
    });
  }

  // --------------------------------
  // INTERFACE
  // --------------------------------

  function findNativePlaylist() {
    return document.querySelector(
      "ytd-playlist-video-list-renderer"
    );
  }

  function createInterface() {
    const native = findNativePlaylist();
    if (!native) return null;

    const existing = document.getElementById("watchwise-root");
    if (existing) return existing;

    nativePlaylist = native;

    const root = document.createElement("section");
    root.id = "watchwise-root";
    root.dataset.view = "grid";

    const header = document.createElement("header");
    header.className = "ww-heading";

    const info = document.createElement("div");

    const eyebrow = document.createElement("div");
    eyebrow.className = "ww-eyebrow";
    eyebrow.textContent = "YOUR PERSONAL VIDEO ORGANIZER";

    const title = document.createElement("h2");
    title.textContent = "WatchWise";

    const status = document.createElement("p");
    status.className = "ww-status";
    status.textContent = "Connecting to Watch Later...";

    info.append(eyebrow, title, status);

    const controls = document.createElement("div");
    controls.className = "ww-controls";

    const toggle = document.createElement("div");
    toggle.className = "ww-view-toggle";

    ["grid", "list"].forEach(view => {
      const button = document.createElement("button");
      button.className = "ww-view-btn";
      button.dataset.view = view;
      button.textContent = view === "grid" ? "Grid" : "List";

      if (view === "grid") {
        button.classList.add("ww-selected");
      }

      button.addEventListener("click", () => {
        root.dataset.view = view;

        toggle.querySelectorAll(".ww-view-btn").forEach(item => {
          item.classList.toggle("ww-selected", item === button);
        });
      });

      toggle.appendChild(button);
    });

    const rescan = document.createElement("button");
    rescan.className = "ww-view-btn";
    rescan.textContent = "Rescan playlist";

    rescan.addEventListener("click", () => {
      if (loading) return;
      reset();
      initialize();
    });

    controls.append(rescan, toggle);
    header.append(info, controls);

    const progress = document.createElement("div");
    progress.className = "ww-progress";

    const progressBar = document.createElement("div");
    progressBar.className = "ww-progress-bar";
    progress.appendChild(progressBar);

    const filters = document.createElement("div");
    filters.className = "ww-filters";

    const grid = document.createElement("div");
    grid.className = "ww-grid";

    root.append(header, progress, filters, grid);

    native.parentElement.insertBefore(root, native);
    native.classList.add("ww-native-hidden");

    return root;
  }

  function setStatus(message, percentage = null) {
    const root = document.getElementById("watchwise-root");
    if (!root) return;

    const status = root.querySelector(".ww-status");
    if (status) status.textContent = message;

    const progress = root.querySelector(".ww-progress");
    const bar = root.querySelector(".ww-progress-bar");

    if (percentage === null) {
      progress.style.display = "none";
    } else {
      progress.style.display = "block";
      bar.style.width = `${Math.min(100, percentage)}%`;
    }
  }

  // --------------------------------
  // VIDEO RENDERING
  // --------------------------------

  function makeChip(label) {
    const button = document.createElement("button");

    button.className = "ww-chip";
    button.type = "button";
    button.textContent = label;

    if (selectedCategory === label) {
      button.classList.add("ww-active");
    }

    button.addEventListener("click", () => {
      selectedCategory = label;
      render();
    });

    return button;
  }

  function render() {
    const root = document.getElementById("watchwise-root");
    if (!root) return;

    const filters = root.querySelector(".ww-filters");
    const grid = root.querySelector(".ww-grid");

    filters.replaceChildren();
    grid.replaceChildren();

    filters.appendChild(makeChip("All"));

    categories.forEach(category => {
      filters.appendChild(makeChip(category.name));
    });

    filters.appendChild(makeChip("Other"));

    const selected = [...videos.values()].filter(video =>
      selectedCategory === "All" ||
      video.category === selectedCategory
    );

    const fragment = document.createDocumentFragment();

    selected.forEach(video => {
      const card = document.createElement("a");

      card.className = "ww-card";
      card.href = video.url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";

      const image = document.createElement("img");
      image.className = "ww-thumbnail";
      image.loading = "lazy";
      image.alt = video.title;
      image.src = video.thumbnail;

      image.addEventListener("error", () => {
        image.src =
          `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`;
      }, { once: true });

      const details = document.createElement("div");
      details.className = "ww-card-details";

      const title = document.createElement("h3");
      title.textContent = video.title;

      const meta = document.createElement("p");
      meta.className = "ww-card-meta";
      meta.textContent = [video.duration, video.category]
        .filter(Boolean)
        .join(" · ");

      details.append(title, meta);
      card.append(image, details);
      fragment.appendChild(card);
    });

    grid.appendChild(fragment);

    let message =
      `${selected.length} videos shown · ${videos.size} collected`;

    if (loading) {
      message += " · Indexing the rest in the background";
    } else if (fullLoaded) {
      message += " · Playlist fully indexed";
    } else if (loadError) {
      message += ` · ${loadError}`;
    }

    setStatus(message);
  }

  // --------------------------------
  // FULL PLAYLIST INDEXING
  // --------------------------------

  async function loadEntirePlaylist() {
    if (loading || fullLoaded) return;

    if (!continuation) {
      fullLoaded = true;
      render();
      return;
    }

    loading = true;
    let pages = 0;

    try {
      while (continuation && pages < MAX_PAGES && !stopped) {
        const previousCount = videos.size;

        await fetchNextPage();

        if (videos.size <= previousCount) {
          throw new Error(
            "The next playlist page did not add any new videos."
          );
        }

        pages++;
        classifyVideos();

        if (pages % RENDER_EVERY === 0) {
          render();

          setStatus(
            `Indexing playlist · ${videos.size} videos collected`,
            Math.min(95, pages / MAX_PAGES * 100)
          );
        }

        await sleep(PAGE_DELAY);
      }

      if (continuation && !stopped) {
        throw new Error(
          "Stopped at the safety limit. The playlist may be larger than expected."
        );
      }

      if (!stopped) {
        fullLoaded = true;
        classifyVideos();
        loadError = null;

        console.log(
          "WatchWise: Full playlist indexed:",
          videos.size
        );
      }

    } catch (error) {
      console.error("WatchWise indexing error:", error);
      loadError = error.message;
    } finally {
      loading = false;
      render();
    }
  }

  // --------------------------------
  // INITIALIZATION
  // --------------------------------

  async function initialize() {
    if (!isWatchLater()) return;

    const root = createInterface();
    if (!root) return;

    try {
      let data = window.ytInitialData;

      for (let i = 0; !data && i < 20; i++) {
        await sleep(300);
        data = window.ytInitialData;
      }

      if (!data) {
        throw new Error("YouTube page data was unavailable.");
      }

      if (!readInitialPlaylist(data)) {
        throw new Error(
          "No Watch Later videos were found in YouTube's page data."
        );
      }

      // Discover categories using the newest sample.
      let pages = 0;

      while (
        videos.size < SAMPLE_SIZE &&
        continuation &&
        pages < 20
      ) {
        await fetchNextPage();
        pages++;
      }

      const sample = [...videos.values()].slice(0, SAMPLE_SIZE);

      if (sample.length < 15) {
        throw new Error(
          `Only ${sample.length} videos were retrieved. ` +
          "Not enough to discover topics."
        );
      }

      setStatus(
        `Discovering topics from ${sample.length} recent videos...`
      );

      discoverTopics(sample);
      classifyVideos();

      selectedCategory = "All";
      render();

      // Continue indexing the rest in the background.
      if (continuation) {
        loadEntirePlaylist();
      } else {
        fullLoaded = true;
        render();
      }

    } catch (error) {
      console.error("WatchWise initialization:", error);
      loadError = error.message;
      setStatus(`Unable to initialize: ${error.message}`);
    }
  }

  // --------------------------------
  // RESET AND YOUTUBE NAVIGATION
  // --------------------------------

  function reset() {
    stopped = true;

    nativePlaylist?.classList.remove("ww-native-hidden");

    document.getElementById("watchwise-root")?.remove();

    videos.clear();
    videos = new Map();

    categories = [];
    vocabulary = new Map();

    continuation = null;
    clickTrackingParams = null;

    fullLoaded = false;
    loading = false;
    loadError = null;
    stopped = false;

    selectedCategory = "All";
    nativePlaylist = null;
  }

  let navigationTimer = null;

  function navigate() {
    clearTimeout(navigationTimer);
    reset();

    if (isWatchLater()) {
      navigationTimer = setTimeout(initialize, 1200);
    }
  }

  setTimeout(initialize, 1200);

  document.addEventListener(
    "yt-navigate-finish",
    navigate
  );

  window.addEventListener("popstate", navigate);

})();
