const { builder } = require("@netlify/functions");
const chromium = require("chrome-aws-lambda");

function isFullUrl(url) {
  try {
    new URL(url);
    return true;
  } catch(e) {
    // invalid url OR local path
    return false;
  }
}

async function screenshot(url, { format, viewport, dpr = 1, withJs = true, wait, timeout = 8500 }) {
  // Must be between 3000 and 8500
  timeout = Math.min(Math.max(timeout, 3000), 8500);

  const browser = await chromium.puppeteer.launch({
    executablePath: await chromium.executablePath,
    args: chromium.args,
    defaultViewport: {
      width: viewport[0],
      height: viewport[1],
      deviceScaleFactor: parseFloat(dpr),
    },
    headless: chromium.headless,
  });

  const page = await browser.newPage();

  if(!withJs) {
    page.setJavaScriptEnabled(false);
  }

  let response = await Promise.race([
    page.goto(url, {
      waitUntil: wait || ["load"],
      timeout,
    }),
    new Promise(resolve => {
      setTimeout(() => {
        resolve(false); // false is expected below
      }, timeout - 1500); // we need time to execute the window.stop before the top level timeout hits
    }),
  ]);

  if(response === false) { // timed out, resolved false
    await page.evaluate(() => window.stop());
  }

  // let statusCode = response.status();
  // TODO handle 4xx/5xx status codes better

  let svg = await page.$("main svg");
  let bbox = await svg.boundingBox();

  let options = {
    type: format,
    encoding: "base64",
    fullPage: false,
    captureBeyondViewport: false,
    clip: {
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: bbox.height,
    }
  };

  if(format === "jpeg") {
    options.quality = 80;
  }

  let output = await page.screenshot(options);

  await browser.close();

  return output;
}

// Based on https://github.com/DavidWells/netlify-functions-workshop/blob/master/lessons-code-complete/use-cases/13-returning-dynamic-images/functions/return-image.js
async function handler(event, context) {
  // e.g. /https%3A%2F%2Fwww.11ty.dev%2F/small/1:1/smaller/
  let pathSplit = event.path.split("/").filter(entry => !!entry);
  let [url, size, aspectratio, zoom, cachebuster] = pathSplit;
  let format = "jpeg"; // hardcoded for now, but png and webp are supported!
  let viewport = [];

  // Manage your own frequency by using a _ prefix and then a hash buster string after your URL
  // e.g. /https%3A%2F%2Fwww.11ty.dev%2F/_20210802/ and set this to today’s date when you deploy
  if(size && size.startsWith("_")) {
    cachebuster = size;
    size = undefined;
  }
  if(aspectratio && aspectratio.startsWith("_")) {
    cachebuster = aspectratio;
    aspectratio = undefined;
  }
  if(zoom && zoom.startsWith("_")) {
    cachebuster = zoom;
    zoom = undefined;
  }

  // Options
  let pathOptions = {};
  let optionsMatch = (cachebuster || "").split("_").filter(entry => !!entry);
  for(let o of optionsMatch) {
    let [key, value] = o.split(":");
    pathOptions[key.toLowerCase()] = parseInt(value, 10);
  }

  let wait = ["load"];
  if(pathOptions.wait === 0) {
    wait = ["domcontentloaded"];
  } else if(pathOptions.wait === 1) {
    wait = ["load"];
  } else if(pathOptions.wait === 2) {
    wait = ["load", "networkidle0"];
  } else if(pathOptions.wait === 3) {
    wait = ["load", "networkidle2"];
  }

  let timeout;
  if(pathOptions.timeout) {
    timeout = pathOptions.timeout * 1000;
  }

  // Set Defaults
  format = format || "jpeg";
  aspectratio = aspectratio || "1:1";
  size = size || "small";
  zoom = zoom || "standard";

  let dpr;
  if(zoom === "bigger") {
    dpr = 1.4;
  } else if(zoom === "smaller") {
    dpr = 0.71428571;
  } else if(zoom === "standard") {
    dpr = 1;
  }

  if(size === "small") {
    if(aspectratio === "1:1") {
      viewport = [375, 375];
    } else if(aspectratio === "9:16") {
      viewport = [375, 667];
    }
  } else if(size === "medium") {
    if(aspectratio === "1:1") {
      viewport = [650, 650];
    } else if(aspectratio === "9:16") {
      viewport = [650, 1156];
    }
  } else if(size === "large") {
    // 0.5625 aspect ratio not supported on large
    if(aspectratio === "1:1") {
      viewport = [1024, 1024];
    }
  } else if(size === "opengraph") {
    // ignores aspectratio
    // always maintain a 1200×630 output image
    if(zoom === "bigger") { // dpr = 1.4
      viewport = [857, 450];
    } else if(zoom === "smaller") { // dpr = 0.714
      viewport = [1680, 882];
    } else {
      viewport = [1200, 630];
    }
  }

  url = decodeURIComponent(url);

  try {
    if(!isFullUrl(url)) {
      throw new Error(`Invalid \`url\`: ${url}`);
    }

    if(!viewport || viewport.length !== 2) {
      throw new Error("Incorrect API usage. Expects one of: /:url/ or /:url/:size/ or /:url/:size/:aspectratio/")
    }

    let output = await screenshot(url, {
      format,
      viewport,
      dpr,
      wait,
      timeout,
    });

    // output to Function logs
    console.log(url, format, { viewport }, { size }, { dpr }, { aspectratio });

    return {
      statusCode: 200,
      headers: {
        "content-type": `image/${format}`
      },
      body: output,
      isBase64Encoded: true
    };
  } catch (error) {
    console.log("Error", error);

    return {
      // We need to return 200 here or Firefox won’t display the image
      // HOWEVER a 200 means that if it times out on the first attempt it will stay the default image until the next build.
      statusCode: 200,
      // HOWEVER HOWEVER, we can set a ttl of 3600 which means that the image will be re-requested in an hour.
      ttl: 3600,
      headers: {
        "content-type": "image/svg+xml",
        "x-error-message": error.message
      },
      body: `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="${viewport[0]}" height="${viewport[1]}" x="0" y="0" viewBox="0 0 90 90" xml:space="preserve" aria-hidden="true" focusable="false"><rect width="90" height="90" fill="white"/><path d="M76.9729 55.6404L62.3718 55.4006" stroke="#DDDDDD" stroke-width="4"/><path d="M54.2471 75.9076L40.7853 70.2481" stroke="#DDDDDD" stroke-width="4"/><path d="M68.9338 62.7846L70.4111 48.2564" stroke="#DDDDDD" stroke-width="4"/><path d="M45.1316 79.9791L49.9006 66.1767" stroke="#DDDDDD" stroke-width="4"/><path d="M65.1982 37.5888L25.0001 62.3549" stroke="#DDDDDD" stroke-width="4"/><path d="M32.0053 57.722L33.2872 50.0177L42.7913 51.4043" stroke="#DDDDDD" stroke-width="4"/></svg>`,
      isBase64Encoded: false,
    };
  }
}

exports.handler = builder(handler);
