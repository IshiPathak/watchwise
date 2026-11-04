
(() => {
  if (window.__watchwiseV3) return;
  window.__watchwiseV3 = true;

  const ROOT_ID = "watchwise-root";
  const ROW_SELECTOR = "ytd-playlist-video-renderer";
  const SAMPLE_SIZE = 200;
  const MAX_ROUNDS = 1200;

  const videos = new Map();

  let categories = [];
  let activeCategory = "all";
  let scanning = false;
  let viewMode = "grid";
  let playlistContents = null;

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
    please like subscribe channel music song songs
  `.split(/\s+/));

  const wait = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

  function isWatchLater() {
    return new URLSearchParams(location.search).get("list") === "WL";
  }

  function getContents() {
    return document.querySelector(
      "ytd-playlist-video-list-renderer #contents"
    );
  }

  function getVideoId(href) {
    try {
      const url = new URL(href, location.origin);

      return url.searchParams.get("v") ||
        url.pathname.match(/\/shorts\/([^/?]+)/)?.[1] ||
        null;
    } catch {
      return null;
    }
  }

  function getDuration(row) {
    const text = [
      ...row.querySelectorAll(
        "ytd-thumbnail-overlay-time-status-renderer, " +
        "ytd-thumbnail-overlay-time-status-renderer span, " +
        "ytd-thumbnail-overlay-time-status-renderer #text"
      )
    ]
      .map(element => element.textContent || "")
      .join(" ");

    return text.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/)?.[0] || "";
  }

  function collectVisibleVideos() {
    let added = 0;

    document.querySelectorAll(ROW_SELECTOR).forEach(row => {
      const link = row.querySelector(
        "a#video-title, a#video-title-link"
      );

      if (!link) return;

      const title = (
        link.getAttribute("title") ||
        link.textContent ||
        ""
      ).replace(/\s+/g, " ").trim();

      const id = getVideoId(link.href);

      if (!id || !title || videos.has(id)) return;

      videos.set(id, {
        id,
        title,
        url: `https://www.youtube.com/watch?v=${id}`,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        duration: getDuration(row),
        category: "Other"
      });

      added++;
    });

    return added;
  }

  // -------------------------------
  // TITLE ANALYSIS
  // -------------------------------

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

    const tokens = [...words];

    // Include adjacent word pairs for more descriptive topics.
    for (let i = 0; i < words.length - 1; i++) {
      tokens.push(`${words[i]}_${words[i + 1]}`);
    }

    return tokens;
  }

  function normalize(vector) {
    let magnitude = 0;

    for (const value of vector.values()) {
      magnitude += value * value;
    }

    magnitude = Math.sqrt(magnitude);

    if (!magnitude) return vector;

    for (const [word, value] of vector) {
      vector.set(word, value / magnitude);
    }

    return vector;
  }

  function cosine(a, b) {
    let dot = 0;

    for (const [word, value] of a) {
      dot += value * (b.get(word) || 0);
    }

    return dot;
  }

  function buildVectors(sample, allVideos) {
    const docs = sample.map(video => ({
      video,
      tokens: tokenize(video.title),
      vector: new Map()
    }));

    const df = new Map();

    docs.forEach(doc => {
      for (const token of new Set(doc.tokens)) {
        df.set(token, (df.get(token) || 0) + 1);
      }
    });

    const minimumFrequency = Math.max(
      2,
      Math.ceil(sample.length * 0.01)
    );

    const vocabulary = new Set(
      [...df.entries()]
        .filter(([, count]) => count >= minimumFrequency)
        .map(([word]) => word)
    );

    function vectorize(title) {
      const tokens = tokenize(title);
      const counts = new Map();

      tokens.forEach(token => {
        if (vocabulary.has(token)) {
          counts.set(token, (counts.get(token) || 0) + 1);
        }
      });

      const vector = new Map();

      counts.forEach((count, word) => {
        const inverseFrequency = Math.log(
          1 + sample.length / (1 + df.get(word))
        );

        vector.set(
          word,
          (1 + Math.log(count)) * inverseFrequency
        );
      });

      return normalize(vector);
    }

    docs.forEach(doc => {
      doc.vector = vectorize(doc.video.title);
    });

    const allVectors = new Map();

    allVideos.forEach(video => {
      allVectors.set(video.id, vectorize(video.title));
    });

    return { docs, allVectors };
  }

  function centroidFor(docs, assignments, cluster) {
    const centroid = new Map();
    let count = 0;

    docs.forEach((doc, index) => {
      if (assignments[index] !== cluster) return;

      count++;

      doc.vector.forEach((value, word) => {
        centroid.set(
          word,
          (centroid.get(word) || 0) + value
        );
      });
    });

    if (!count) return centroid;

    centroid.forEach((value, word) => {
      centroid.set(word, value / count);
    });

    return normalize(centroid);
  }

  // -------------------------------
  // AUTOMATIC TOPIC DISCOVERY
  // -------------------------------

  function discoverTopics(sample, allVideos) {
    const { docs, allVectors } = buildVectors(
      sample,
      allVideos
    );

    const usefulDocs = docs.filter(
      doc => doc.vector.size > 0
    );

    if (usefulDocs.length < 15) {
      return {
        groups: [],
        allVectors,
        centroids: []
      };
    }

    const k = Math.min(
      12,
      Math.max(8, Math.round(usefulDocs.length / 20)),
      Math.floor(usefulDocs.length / 5)
    );

    // Deterministic farthest-first initialization.
    const centroids = [usefulDocs[0].vector];

    while (centroids.length < k) {
      let best = null;
      let bestDistance = -1;

      usefulDocs.forEach(doc => {
        const closest = Math.max(
          ...centroids.map(center =>
            cosine(doc.vector, center)
          )
        );

        const distance = 1 - closest;

        if (distance > bestDistance) {
          bestDistance = distance;
          best = doc;
        }
      });

      if (!best) break;

      centroids.push(best.vector);
    }

    let assignments = new Array(usefulDocs.length).fill(-1);

    // Spherical K-means clustering.
    for (let iteration = 0; iteration < 25; iteration++) {
      let changed = false;

      usefulDocs.forEach((doc, index) => {
        let bestCluster = 0;
        let bestScore = -1;

        centroids.forEach((center, cluster) => {
          const score = cosine(doc.vector, center);

          if (score > bestScore) {
            bestScore = score;
            bestCluster = cluster;
          }
        });

        if (assignments[index] !== bestCluster) {
          assignments[index] = bestCluster;
          changed = true;
        }
      });

      for (let cluster = 0; cluster < k; cluster++) {
        const updated = centroidFor(
          usefulDocs,
          assignments,
          cluster
        );

        if (updated.size) {
          centroids[cluster] = updated;
        }
      }

      if (!changed) break;
    }

    const groups = [];

    for (let cluster = 0; cluster < k; cluster++) {
      const members = usefulDocs.filter(
        (_, index) => assignments[index] === cluster
      );

      if (members.length < 3) continue;

      const scores = new Map();
      const occurrences = new Map();

      members.forEach(doc => {
        doc.vector.forEach((value, word) => {
          scores.set(
            word,
            (scores.get(word) || 0) + value
          );

          occurrences.set(
            word,
            (occurrences.get(word) || 0) + 1
          );
        });
      });

      const keywords = [...scores.entries()]
        .filter(([word]) => occurrences.get(word) >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([word]) => word.replace(/_/g, " "));

      if (!keywords.length) continue;

      const name = keywords
        .map(word =>
          word.charAt(0).toUpperCase() + word.slice(1)
        )
        .join(" & ");

      groups.push({
        name,
        centroid: centroids[cluster],
        sampleCount: members.length
      });
    }

    // Ensure category names are unique.
    const usedNames = new Map();

    groups.forEach(group => {
      const base = group.name;
      const count = (usedNames.get(base) || 0) + 1;

      usedNames.set(base, count);

      if (count > 1) {
        group.name = `${base} ${count}`;
      }
    });

    return { groups, allVectors, centroids };
  }

  function classifyAllVideos(allVideos, discovery) {
    const { groups, allVectors } = discovery;

    allVideos.forEach(video => {
      const vector = allVectors.get(video.id);

      if (!vector || !vector.size || !groups.length) {
        video.category = "Other";
        return;
      }

      let bestGroup = null;
      let bestScore = -1;

      groups.forEach(group => {
        const score = cosine(vector, group.centroid);

        if (score > bestScore) {
          bestScore = score;
          bestGroup = group;
        }
      });

      // Avoid assigning unrelated titles to an arbitrary topic.
      video.category =
        bestGroup && bestScore >= 0.08
          ? bestGroup.name
          : "Other";
    });

    const results = groups.map(group => ({
      name: group.name,
      videos: allVideos.filter(
        video => video.category === group.name
      )
    }));

    const otherVideos = allVideos.filter(
      video => video.category === "Other"
    );

    if (otherVideos.length) {
      results.push({
        name: "Other",
        videos: otherVideos
      });
    }

    return results
      .filter(group => group.videos.length > 0)
      .sort((a, b) => b.videos.length - a.videos.length);
  }

  // -------------------------------
  // INTERFACE
  // -------------------------------

  function createInterface() {
    const existing = document.getElementById(ROOT_ID);

    if (existing) return existing;

    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.dataset.view = viewMode;

    root.innerHTML = `
      <div class="ww-heading">
        <div>
          <div class="ww-eyebrow">YOUR PERSONAL VIDEO ORGANIZER</div>
          <h2>WatchWise</h2>
          <p class="ww-status">
            Discover topics from your Watch Later playlist.
          </p>
        </div>

        <div class="ww-controls">
          <button class="ww-scan" type="button">
            Scan playlist
          </button>

          <div class="ww-view-toggle">
            <button class="ww-view-btn ww-selected"
              data-view="grid" type="button">Grid</button>
            <button class="ww-view-btn"
              data-view="list" type="button">List</button>
          </div>
        </div>
      </div>

      <div class="ww-filters"></div>
      <div class="ww-grid"></div>
    `;

    playlistContents = getContents();

    if (playlistContents?.parentElement) {
      playlistContents.parentElement.insertBefore(
        root,
        playlistContents
      );
    } else {
      return null;
    }

    root.querySelector(".ww-scan").addEventListener(
      "click",
      scanPlaylist
    );

    root.querySelectorAll(".ww-view-btn").forEach(button => {
      button.addEventListener("click", () => {
        viewMode = button.dataset.view;
        root.dataset.view = viewMode;

        root.querySelectorAll(".ww-view-btn").forEach(btn => {
          btn.classList.toggle(
            "ww-selected",
            btn === button
          );
        });
      });
    });

    return root;
  }

  function makeChip(label, category) {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "ww-chip";
    button.textContent = label;

    if (activeCategory === category) {
      button.classList.add("ww-active");
    }

    button.setAttribute(
      "aria-pressed",
      String(activeCategory === category)
    );

    button.addEventListener("click", () => {
      activeCategory = category;
      renderResults();
    });

    return button;
  }

  function renderResults() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    const filters = root.querySelector(".ww-filters");
    const grid = root.querySelector(".ww-grid");

    filters.replaceChildren();
    grid.replaceChildren();

    filters.appendChild(
      makeChip(`All (${videos.size})`, "all")
    );

    categories.forEach(category => {
      filters.appendChild(
        makeChip(
          `${category.name} (${category.videos.length})`,
          category.name
        )
      );
    });

    const selectedVideos = activeCategory === "all"
      ? [...videos.values()]
      : categories.find(
          category => category.name === activeCategory
        )?.videos || [];

    const fragment = document.createDocumentFragment();

    selectedVideos.forEach(video => {
      const card = document.createElement("a");

      card.className = "ww-card";
      card.href = video.url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      card.title = video.title;

      const image = document.createElement("img");

      image.className = "ww-thumbnail";
      image.alt = "";
      image.loading = "lazy";
      image.src = video.thumbnail;

      image.addEventListener("error", () => {
        if (!image.dataset.fallback) {
          image.dataset.fallback = "true";
          image.src =
            `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`;
        } else {
          image.style.visibility = "hidden";
        }
      });

      const details = document.createElement("div");
      details.className = "ww-card-details";

      const title = document.createElement("h3");
      title.textContent = video.title;

      const meta = document.createElement("p");
      meta.className = "ww-card-meta";
      meta.textContent = [
        video.duration,
        video.category
      ].filter(Boolean).join(" · ");

      details.append(title, meta);
      card.append(image, details);

      fragment.appendChild(card);
    });

    grid.appendChild(fragment);

    root.querySelector(".ww-status").textContent =
      `${selectedVideos.length} videos shown · ` +
      `${categories.length} discovered topics · ` +
      `${videos.size} collected`;
  }

  // -------------------------------
  // PLAYLIST SCANNER
  // -------------------------------

  function getScrollElement() {
    return document.scrollingElement || document.documentElement;
  }

  async function scanPlaylist() {
    if (scanning) return;

    const root = document.getElementById(ROOT_ID);
    playlistContents = getContents();

    if (!root || !playlistContents) return;

    scanning = true;

    const button = root.querySelector(".ww-scan");
    const status = root.querySelector(".ww-status");

    button.disabled = true;
    button.textContent = "Scanning...";

    // Allow a fresh scan after revealing the native playlist.
    playlistContents.classList.remove("ww-native-hidden");

    videos.clear();
    categories = [];
    activeCategory = "all";

    const scrollElement = getScrollElement();
    const originalScroll = window.scrollY;

    let unchangedRounds = 0;
    let rounds = 0;
    let lastHeight = 0;

    try {
      while (rounds < MAX_ROUNDS) {
        const added = collectVisibleVideos();

        if (added > 0) {
          unchangedRounds = 0;
        } else {
          unchangedRounds++;
        }

        const currentHeight = scrollElement.scrollHeight;

        status.textContent =
          `Collecting playlist... ${videos.size} videos found`;

        const atBottom =
          window.innerHeight + window.scrollY >=
          currentHeight - 180;

        if (atBottom) {
          // Give YouTube time to load the next batch.
          await wait(1000);

          const newlyAdded = collectVisibleVideos();

          if (newlyAdded > 0) {
            unchangedRounds = 0;
          } else {
            unchangedRounds++;
          }

          const newHeight = scrollElement.scrollHeight;

          if (
            unchangedRounds >= 12 &&
            newHeight <= currentHeight
          ) {
            break;
          }
        } else {
          window.scrollBy({
            top: Math.max(500, window.innerHeight * 0.8),
            behavior: "instant"
          });

          await wait(650);
        }

        if (currentHeight !== lastHeight) {
          lastHeight = currentHeight;
        }

        rounds++;
      }

      collectVisibleVideos();

      const allVideos = [...videos.values()];

      if (allVideos.length < 15) {
        status.textContent =
          `Only ${allVideos.length} videos found. ` +
          `Please check that Watch Later is fully loaded.`;
        return;
      }

      status.textContent =
        `Discovering topics from ${Math.min(
          SAMPLE_SIZE,
          allVideos.length
        )} sample videos...`;

      // Use a deterministic sample spread across the collection.
      const sample = allVideos.length <= SAMPLE_SIZE
        ? allVideos
        : Array.from(
            { length: SAMPLE_SIZE },
            (_, index) => {
              const position = Math.floor(
                index * (allVideos.length - 1) /
                (SAMPLE_SIZE - 1)
              );

              return allVideos[position];
            }
          );

      const discovery = discoverTopics(sample, allVideos);

      if (!discovery.groups.length) {
        status.textContent =
          "Not enough repeated title keywords to discover topics.";
        return;
      }

      status.textContent =
        "Classifying all collected videos...";

      categories = classifyAllVideos(
        allVideos,
        discovery
      );

      activeCategory = "all";

      // Hide YouTube's original list only after collection.
      playlistContents.classList.add("ww-native-hidden");

      renderResults();

      button.textContent = "Rescan playlist";
    } catch (error) {
      console.error("WatchWise V3 error:", error);

      status.textContent =
        "Something went wrong. Check the browser console.";

      playlistContents?.classList.remove("ww-native-hidden");
    } finally {
      window.scrollTo({
        top: originalScroll,
        behavior: "instant"
      });

      scanning = false;
      button.disabled = false;

      if (button.textContent === "Scanning...") {
        button.textContent = "Try again";
      }
    }
  }

  // -------------------------------
  // INITIALIZATION / NAVIGATION
  // -------------------------------

  function reset() {
    playlistContents?.classList.remove("ww-native-hidden");

    document.getElementById(ROOT_ID)?.remove();

    videos.clear();
    categories = [];
    activeCategory = "all";
    scanning = false;
    playlistContents = null;
  }

  function initialize() {
    if (!isWatchLater()) return;

    if (document.getElementById(ROOT_ID)) return;

    const contents = getContents();

    if (!contents) return;

    createInterface();
  }

  function handleNavigation() {
    reset();

    if (isWatchLater()) {
      setTimeout(initialize, 700);
      setTimeout(initialize, 1800);
    }
  }

  // Initial page.
  setTimeout(initialize, 700);

  // YouTube single-page navigation.
  document.addEventListener(
    "yt-navigate-finish",
    handleNavigation
  );

  window.addEventListener(
    "popstate",
    handleNavigation
  );
})();
