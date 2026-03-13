const axios = require("axios");

const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

async function postToFacebook(message) {
  if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
    console.warn("Facebook posting skipped: missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN");
    return null;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${FB_PAGE_ID}/feed`,
      null,
      {
        params: {
          message,
          access_token: FB_PAGE_ACCESS_TOKEN,
        },
      }
    );

    console.log("Facebook post created:", response.data.id);
    return response.data;
  } catch (error) {
    console.error(
      "Facebook post failed:",
      error.response?.data || error.message || error
    );
    return null;
  }
}

module.exports = {
  postToFacebook,
};