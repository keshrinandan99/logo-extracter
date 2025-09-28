const axios = require("axios");
const cheerio = require("cheerio");
const sharp = require("sharp");
const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");

class SimpleLogo {
  static async extractLogo(url, outputDir = "./logos") {
    try {
      await fs.mkdir(outputDir, { recursive: true });

      const pageUrl = url;
      const baseUrl = new URL(url).origin;
      const domain = new URL(url).hostname.replace("www.", "");

      // 1) Try to fetch HTML, but continue without it if it fails (e.g., 403)
      let $,
        htmlAvailable = false;
      try {
        const response = await this.fetchHtmlWithFallback(pageUrl);
        $ = cheerio.load(response.data);
        htmlAvailable = true;
      } catch (e) {
        htmlAvailable = false;
      }

      const addCandidate = (() => {
        const seen = new Set();
        const candidates = [];
        return (src, priority, source, extra = {}) => {
          if (typeof src === "undefined") return candidates;
          if (!src) return candidates;
          const normalized = this.normalizeUrl(src, baseUrl);
          if (!normalized || !this.isValidImageUrl(normalized))
            return candidates;
          if (seen.has(normalized)) return candidates;
          seen.add(normalized);
          candidates.push({ url: normalized, priority, source, ...extra });
          return candidates;
        };
      })();

      // 2) Collect from <head>: meta, link, manifest (only if HTML was fetched)
      if (htmlAvailable) {
        const head = $("head");

        // Meta image tags (highest quality first)
        head
          .find(
            'meta[property="og:image"][content], meta[name="twitter:image"][content], meta[itemprop="image"][content], meta[name="msapplication-TileImage"][content]'
          )
          .each((i, el) => {
            const content = $(el).attr("content");
            addCandidate(content, 1, "meta");
          });

        // Link icon tags (multiple sizes)
        head
          .find(
            'link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="icon"], link[rel="shortcut icon"], link[rel="mask-icon"]'
          )
          .each((i, el) => {
            const href = $(el).attr("href");
            const sizes = $(el).attr("sizes");
            addCandidate(href, 2, "link", { sizes });
          });

        // From page <header> region - common logo placements
        $(
          'header .logo img[src], header #logo img[src], header img[alt*="logo" i][src]'
        ).each((i, el) => {
          addCandidate($(el).attr("src"), 6, "header");
        });

        // Keep previous generic logo selectors as a fallback
        $(".logo img[src], #logo img[src]").each((i, el) => {
          addCandidate($(el).attr("src"), 7, "logo-section");
        });
        $('img[alt*="logo" i][src]').each((i, el) => {
          addCandidate($(el).attr("src"), 8, "img[alt*=logo]");
        });

        // Parse Web App Manifest if present (often lists multiple icons)
        const manifestHref = head.find('link[rel="manifest"]').attr("href");
        if (manifestHref) {
          try {
            const manifestUrl = this.normalizeUrl(manifestHref, baseUrl);
            const mResp = await axios.get(manifestUrl, {
              timeout: 7000,
              headers: this.buildDefaultHeaders("json", pageUrl),
            });
            if (mResp && mResp.data && Array.isArray(mResp.data.icons)) {
              mResp.data.icons.forEach((icon) => {
                if (icon && icon.src) {
                  addCandidate(icon.src, 3, "manifest", { sizes: icon.sizes });
                }
              });
            }
          } catch (err) {
            // Ignore manifest errors and continue
          }
        }
      }

      // 3) Include common favicon/logo paths (always try these)
      const commonPaths = [
        "/favicon.svg",
        "/logo.svg",
        "/favicon.ico",
        "/favicon.png",
        "/favicon.jpg",
        "/favicon.jpeg",
        "/favicon.gif",
        "/favicon.webp",
        "/logo.png",
        "/apple-touch-icon.png",
        "/apple-touch-icon-precomposed.png",
        "/android-chrome-192x192.png",
        "/android-chrome-512x512.png",
        "/mstile-150x150.png",
      ];
      commonPaths.forEach((p) => addCandidate(baseUrl + p, 10, "common-path"));

      // Extract collected candidates
      let foundLogos = addCandidate(); // retrieve internal array
      foundLogos = Array.isArray(foundLogos) ? foundLogos : [];

      // Sort by priority (lower is better)
      foundLogos.sort((a, b) => a.priority - b.priority);

      // 4) Download all candidates with 403-friendly headers and save uniquely
      const saved = [];
      let index = 1;

      for (const candidate of foundLogos) {
        try {
          const imgResponse = await this.downloadWithFallback(
            candidate.url,
            pageUrl
          );
          const contentType =
            imgResponse.headers && imgResponse.headers["content-type"];
          const format = this.detectImageFormat(candidate.url, contentType);

          const filename = `${domain}-logo${
            index === 1 ? "" : "-" + index
          }.${format}`;
          const filepath = path.join(outputDir, filename);

          if (format === "svg") {
            await fs.writeFile(filepath, imgResponse.data);
          } else if (this.shouldOptimize(format)) {
            try {
              let sharpInstance = sharp(imgResponse.data);
              const metadata = await sharpInstance.metadata();
              if (
                (metadata.width && metadata.width > 512) ||
                (metadata.height && metadata.height > 512)
              ) {
                sharpInstance = sharpInstance.resize(512, 512, {
                  fit: "inside",
                  withoutEnlargement: true,
                });
              }
              switch (format) {
                case "png":
                  await sharpInstance.png().toFile(filepath);
                  break;
                case "jpg":
                case "jpeg":
                  await sharpInstance.jpeg({ quality: 90 }).toFile(filepath);
                  break;
                case "webp":
                  await sharpInstance.webp({ quality: 90 }).toFile(filepath);
                  break;
                default:
                  await fs.writeFile(filepath, imgResponse.data);
              }
            } catch (sharpError) {
              // If optimization fails, save directly
              await fs.writeFile(filepath, imgResponse.data);
            }
          } else if (format === "ico" || format === "gif") {
            await fs.writeFile(filepath, imgResponse.data);
          } else {
            await fs.writeFile(filepath, imgResponse.data);
          }

          saved.push({
            url: candidate.url,
            localPath: filepath,
            filename,
            format,
            source: candidate.source,
            contentType,
          });
          index += 1;
        } catch (e) {
          // Skip download errors and continue to next candidate
        }
      }

      // 5) If nothing saved yet, use provider-based favicon fallbacks (helps with 403)
      if (saved.length === 0) {
        const providerCandidates = [
          {
            url: `https://www.google.com/s2/favicons?sz=256&domain_url=https://${domain}`,
            fmt: "png",
            source: "google-favicons",
          },
          {
            url: `https://icons.duckduckgo.com/ip3/${domain}.ico`,
            fmt: "ico",
            source: "duckduckgo-favicons",
          },
        ];
        for (const prov of providerCandidates) {
          try {
            const resp = await this.downloadWithFallback(prov.url, baseUrl);
            const filename = `${domain}-logo-fallback.${prov.fmt}`;
            const filepath = path.join(outputDir, filename);
            await fs.writeFile(filepath, resp.data);
            saved.push({
              url: prov.url,
              localPath: filepath,
              filename,
              format: prov.fmt,
              source: prov.source,
              contentType: resp.headers && resp.headers["content-type"],
            });
          } catch (e) {
            // continue
          }
        }
      }

      if (saved.length === 0) {
        throw new Error("Failed to download any logos");
      }

      // Keep backward-compatible primary fields referencing the best/sorted first
      const primary = saved[0];

      return {
        success: true,
        domain,
        count: saved.length,
        logos: saved,
        // Back-compat fields
        logoUrl: primary.url,
        localPath: primary.localPath,
        filename: primary.filename,
        format: primary.format,
        source: primary.source,
        contentType: primary.contentType,
      };
    } catch (error) {
      // As a final fallback, try provider icons even if earlier steps threw
      try {
        const domain = new URL(url).hostname.replace("www.", "");
        const outputDir = arguments[1] || "./logos";
        await fs.mkdir(outputDir, { recursive: true });
        const providerCandidates = [
          {
            url: `https://www.google.com/s2/favicons?sz=256&domain_url=https://${domain}`,
            fmt: "png",
            source: "google-favicons",
          },
          {
            url: `https://icons.duckduckgo.com/ip3/${domain}.ico`,
            fmt: "ico",
            source: "duckduckgo-favicons",
          },
        ];
        const saved = [];
        for (const prov of providerCandidates) {
          try {
            const resp = await this.downloadWithFallback(
              prov.url,
              `https://${domain}`
            );
            const filename = `${domain}-logo-fallback.${prov.fmt}`;
            const filepath = path.join(outputDir, filename);
            await fs.writeFile(filepath, resp.data);
            saved.push({
              url: prov.url,
              localPath: filepath,
              filename,
              format: prov.fmt,
              source: prov.source,
              contentType: resp.headers && resp.headers["content-type"],
            });
          } catch (e) {}
        }
        if (saved.length > 0) {
          const primary = saved[0];
          return {
            success: true,
            domain,
            count: saved.length,
            logos: saved,
            logoUrl: primary.url,
            localPath: primary.localPath,
            filename: primary.filename,
            format: primary.format,
            source: primary.source,
            contentType: primary.contentType,
          };
        }
      } catch (_) {}
      return {
        success: false,
        error: error.message,
        domain: new URL(url).hostname.replace("www.", ""),
      };
    }
  }

  static normalizeUrl(url, baseUrl) {
    if (!url) return null;

    if (url.startsWith("//")) {
      return "https:" + url;
    } else if (url.startsWith("/")) {
      return baseUrl + url;
    } else if (url.startsWith("http")) {
      return url;
    } else {
      return baseUrl + "/" + url;
    }
  }

  static isValidImageUrl(url) {
    const imageExtensions = [
      ".png",
      ".jpg",
      ".jpeg",
      ".svg",
      ".gif",
      ".webp",
      ".ico",
      ".bmp",
      ".tiff",
    ];
    return (
      imageExtensions.some((ext) => url.toLowerCase().includes(ext)) ||
      url.includes("logo") ||
      url.includes("icon")
    );
  }

  static detectImageFormat(url, contentType) {
    // First try to detect from content-type
    if (contentType) {
      const typeMap = {
        "image/svg+xml": "svg",
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/x-icon": "ico",
        "image/vnd.microsoft.icon": "ico",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
      };

      if (typeMap[contentType.toLowerCase()]) {
        return typeMap[contentType.toLowerCase()];
      }
    }

    // Fallback to URL-based detection
    const url_lower = url.toLowerCase();
    if (url_lower.includes(".svg")) return "svg";
    if (url_lower.includes(".png")) return "png";
    if (url_lower.includes(".jpg") || url_lower.includes(".jpeg")) return "jpg";
    if (url_lower.includes(".gif")) return "gif";
    if (url_lower.includes(".webp")) return "webp";
    if (url_lower.includes(".ico")) return "ico";
    if (url_lower.includes(".bmp")) return "bmp";
    if (url_lower.includes(".tiff") || url_lower.includes(".tif"))
      return "tiff";

    // Default to png if can't determine
    return "png";
  }

  static shouldOptimize(format) {
    // Only optimize formats that Sharp handles well
    const optimizableFormats = ["png", "jpg", "jpeg", "webp"];
    return optimizableFormats.includes(format);
  }

  static buildDefaultHeaders(kind = "html", referer) {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
    const origin = (() => {
      try {
        return referer ? new URL(referer).origin : undefined;
      } catch {
        return undefined;
      }
    })();
    const common = {
      "User-Agent": ua,
      "Accept-Language": "en-US,en;q=0.9",
      ...(origin
        ? { Origin: origin, Referer: referer }
        : referer
        ? { Referer: referer }
        : {}),
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
    };

    if (kind === "image") {
      return {
        ...common,
        Accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      };
    }
    if (kind === "json") {
      return {
        ...common,
        Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      };
    }
    // html default
    return {
      ...common,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
    };
  }

  static async fetchHtmlWithFallback(pageUrl) {
    const headers = this.buildDefaultHeaders("html", new URL(pageUrl).origin);
    try {
      return await axios.get(pageUrl, { timeout: 12000, headers });
    } catch (err) {
      // Try swapping protocol as a simple fallback (some sites gate 403 per scheme)
      try {
        const swapped = this.trySwapProtocol(pageUrl);
        if (swapped) {
          return await axios.get(swapped, { timeout: 12000, headers });
        }
      } catch (e) {}
      throw err;
    }
  }

  static async downloadWithFallback(resourceUrl, referer) {
    const originReferer = (() => {
      try {
        return new URL(referer).origin;
      } catch {
        return referer;
      }
    })();

    const attempt = async (urlToFetch, refererToUse) => {
      return await axios.get(urlToFetch, {
        responseType: "arraybuffer",
        timeout: 15000,
        headers: this.buildDefaultHeaders("image", refererToUse),
      });
    };

    // Attempt 1: provided referer (pageUrl)
    try {
      return await attempt(resourceUrl, referer);
    } catch (err1) {
      // Attempt 2: origin-only referer
      try {
        return await attempt(resourceUrl, originReferer);
      } catch (err2) {
        // Attempt 3: swap protocol http<->https
        try {
          const swapped = this.trySwapProtocol(resourceUrl);
          if (swapped) {
            return await attempt(swapped, originReferer);
          }
        } catch (err3) {}
        // Propagate last error
        throw err2;
      }
    }
  }

  static trySwapProtocol(inputUrl) {
    try {
      const u = new URL(inputUrl);
      if (u.protocol === "https:") {
        u.protocol = "http:";
        return u.toString();
      }
      if (u.protocol === "http:") {
        u.protocol = "https:";
        return u.toString();
      }
      return null;
    } catch {
      return null;
    }
  }
}

// Usage examples
async function testLogoExtraction() {
  const urls = [
    "https://github.com",
    "https://stackoverflow.com",
    "https://google.com",
    "https://facebook.com",
    "https://stage.openlogo.fyi",
    "https://leetcode.com",
    "https://codeforces.com",
    "https://www.youtube.com/",
  ];

  for (const url of urls) {
    console.log(`\nExtracting logo from: ${url}`);
    const result = await SimpleLogo.extractLogo(url);
    console.log(
      result.success
        ? `Saved ${result.count} logo(s)`
        : `Failed: ${result.error}`
    );
  }
}

// Batch processing function
async function batchExtractLogos(urls, outputDir = "./logos") {
  const results = [];

  for (const url of urls) {
    try {
      const result = await SimpleLogo.extractLogo(url, outputDir);
      results.push(result);
      console.log(
        `✓ ${result.domain}: ${
          result.success ? `Success (${result.count} logo(s))` : "Failed"
        }`
      );
    } catch (error) {
      results.push({
        success: false,
        error: error.message,
        domain: new URL(url).hostname,
      });
    }

    // Add delay to be respectful
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return results;
}

module.exports = { SimpleLogo, batchExtractLogos };

// Run test if called directly
if (require.main === module) {
  testLogoExtraction();
}
