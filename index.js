const axios = require('axios');
const cheerio = require('cheerio');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const { URL } = require('url');

class SimpleLogo {
  static async extractLogo(url, outputDir = './logos') {
    try {
      await fs.mkdir(outputDir, { recursive: true });
      
      const baseUrl = new URL(url).origin;
      const domain = new URL(url).hostname.replace('www.', '');

      // 1. Try to get HTML and parse for logo sources
      const response = await axios.get(url, { 
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      
      // Priority order for logo sources
      const logoSources = [
        // High quality meta tags
        { selector: 'meta[property="og:image"]', attr: 'content', priority: 1 },
        { selector: 'link[rel="apple-touch-icon"]', attr: 'href', priority: 2 },
        { selector: 'link[rel="icon"][type="image/svg+xml"]', attr: 'href', priority: 3 },
        { selector: 'link[rel="shortcut icon"]', attr: 'href', priority: 4 },
        { selector: 'link[rel="icon"]', attr: 'href', priority: 5 },
        
        // Common logo selectors
        { selector: '.logo img', attr: 'src', priority: 6 },
        { selector: '#logo img', attr: 'src', priority: 7 },
        { selector: 'img[alt*="logo" i]:first', attr: 'src', priority: 8 },
      ];

      const foundLogos = [];

      // Extract logos from HTML
      logoSources.forEach(source => {
        $(source.selector).each((i, el) => {
          let src = $(el).attr(source.attr);
          if (src) {
            src = this.normalizeUrl(src, baseUrl);
            if (src && this.isValidImageUrl(src)) {
              foundLogos.push({
                url: src,
                priority: source.priority,
                source: source.selector
              });
            }
          }
        });
      });

      // 2. Try common favicon paths if nothing found
      if (foundLogos.length === 0) {
        const commonPaths = [
          '/favicon.svg',
          '/favicon.png', 
          '/logo.svg',
          '/logo.png',
          '/favicon.ico',
          '/favicon.jpg',
          '/favicon.jpeg',
          '/favicon.gif',
          '/favicon.webp'
        ];

        for (const logoPath of commonPaths) {
          try {
            const logoUrl = baseUrl + logoPath;
            const headResponse = await axios.head(logoUrl, { timeout: 5000 });
            
            if (headResponse.status === 200) {
              foundLogos.push({
                url: logoUrl,
                priority: 10,
                source: 'common-path'
              });
              break; // Take the first one found
            }
          } catch (err) {
            // Continue to next path
          }
        }
      }

      if (foundLogos.length === 0) {
        throw new Error('No logo found');
      }

      // Sort by priority and download the best one
      foundLogos.sort((a, b) => a.priority - b.priority);
      const bestLogo = foundLogos[0];

      // Download the logo
      const logoResponse = await axios.get(bestLogo.url, { 
        responseType: 'arraybuffer',
        timeout: 10000
      });

      // Determine file format from URL and content-type
      const format = this.detectImageFormat(bestLogo.url, logoResponse.headers['content-type']);
      const filename = `${domain}-logo.${format}`;
      const filepath = path.join(outputDir, filename);

      // Save based on format
      if (format === 'svg') {
        // Save SVG directly
        await fs.writeFile(filepath, logoResponse.data);
      } else if (this.shouldOptimize(format)) {
        // Optimize raster images (resize if too large, but keep original format)
        try {
          let sharpInstance = sharp(logoResponse.data);
          
          // Get metadata to check size
          const metadata = await sharpInstance.metadata();
          
          // Only resize if image is very large (over 512px)
          if (metadata.width > 512 || metadata.height > 512) {
            sharpInstance = sharpInstance.resize(512, 512, { 
              fit: 'inside',
              withoutEnlargement: true 
            });
          }

          // Output in original format
          switch (format) {
            case 'png':
              await sharpInstance.png().toFile(filepath);
              break;
            case 'jpg':
            case 'jpeg':
              await sharpInstance.jpeg({ quality: 90 }).toFile(filepath);
              break;
            case 'gif':
              // Sharp doesn't handle GIF well, save directly
              await fs.writeFile(filepath, logoResponse.data);
              break;
            case 'webp':
              await sharpInstance.webp({ quality: 90 }).toFile(filepath);
              break;
            case 'ico':
              // ICO files should be saved directly
              await fs.writeFile(filepath, logoResponse.data);
              break;
            default:
              await fs.writeFile(filepath, logoResponse.data);
          }
        } catch (sharpError) {
          // If Sharp fails, save directly
          console.warn(`Sharp optimization failed for ${filename}, saving directly:`, sharpError.message);
          await fs.writeFile(filepath, logoResponse.data);
        }
      } else {
        // Save other formats directly
        await fs.writeFile(filepath, logoResponse.data);
      }

      return {
        success: true,
        logoUrl: bestLogo.url,
        localPath: filepath,
        filename: filename,
        format: format,
        source: bestLogo.source,
        domain: domain,
        contentType: logoResponse.headers['content-type']
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        domain: new URL(url).hostname.replace('www.', '')
      };
    }
  }

  static normalizeUrl(url, baseUrl) {
    if (!url) return null;
    
    if (url.startsWith('//')) {
      return 'https:' + url;
    } else if (url.startsWith('/')) {
      return baseUrl + url;
    } else if (url.startsWith('http')) {
      return url;
    } else {
      return baseUrl + '/' + url;
    }
  }

  static isValidImageUrl(url) {
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.ico', '.bmp', '.tiff'];
    return imageExtensions.some(ext => url.toLowerCase().includes(ext)) ||
           url.includes('logo') || url.includes('icon');
  }

  static detectImageFormat(url, contentType) {
    // First try to detect from content-type
    if (contentType) {
      const typeMap = {
        'image/svg+xml': 'svg',
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/x-icon': 'ico',
        'image/vnd.microsoft.icon': 'ico',
        'image/bmp': 'bmp',
        'image/tiff': 'tiff'
      };
      
      if (typeMap[contentType.toLowerCase()]) {
        return typeMap[contentType.toLowerCase()];
      }
    }

    // Fallback to URL-based detection
    const url_lower = url.toLowerCase();
    if (url_lower.includes('.svg')) return 'svg';
    if (url_lower.includes('.png')) return 'png';
    if (url_lower.includes('.jpg') || url_lower.includes('.jpeg')) return 'jpg';
    if (url_lower.includes('.gif')) return 'gif';
    if (url_lower.includes('.webp')) return 'webp';
    if (url_lower.includes('.ico')) return 'ico';
    if (url_lower.includes('.bmp')) return 'bmp';
    if (url_lower.includes('.tiff') || url_lower.includes('.tif')) return 'tiff';

    // Default to png if can't determine
    return 'png';
  }

  static shouldOptimize(format) {
    // Only optimize formats that Sharp handles well
    const optimizableFormats = ['png', 'jpg', 'jpeg', 'webp'];
    return optimizableFormats.includes(format);
  }
}

// Usage examples
async function testLogoExtraction() {
  const urls = [
    'https://github.com',
    'https://stackoverflow.com',
    'https://google.com',
    'https://facebook.com',
    'https://stage.openlogo.fyi',
    'https://leetcode.com',
    'https://codeforces.com',
    'https://www.youtube.com/'
  ];

  for (const url of urls) {
    console.log(`\nExtracting logo from: ${url}`);
    const result = await SimpleLogo.extractLogo(url);
    console.log(result);
  }
}

// Batch processing function
async function batchExtractLogos(urls, outputDir = './logos') {
  const results = [];
  
  for (const url of urls) {
    try {
      const result = await SimpleLogo.extractLogo(url, outputDir);
      results.push(result);
      console.log(`✓ ${result.domain}: ${result.success ? `Success (${result.format})` : 'Failed'}`);
    } catch (error) {
      results.push({
        success: false,
        error: error.message,
        domain: new URL(url).hostname
      });
    }
    
    // Add delay to be respectful
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return results;
}

module.exports = { SimpleLogo, batchExtractLogos };

// Run test if called directly
if (require.main === module) {
  testLogoExtraction();
}