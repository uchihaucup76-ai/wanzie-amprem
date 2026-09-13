const axios = require('axios');
const crypto = require('crypto');

class AlightMotionAuth {
    constructor() {
        this.ORDER_ID = "ndyofficial";
        this.API_KEY = "AIzaSyDtG1AU22ErnQD60AzBAcaknySiz9_CEq0";
        this.PRODUCT_ID = "am.full.sub.annual.19q4";
        this.TOKEN = "mmgaobamlahbbeccfplmbkbb.AO-J1OzqG0or_GJJIx-ms8GrTm-jaglCRfhQSRPUZKpl2YspYS-oN7_94uv8RC5vQbvd_Ios2pPDStZ2n7F0hLE3FiOU7HS3R6Fquulv5xLXFECSv4ctElw";
        this.SKU_TYPE = "subs";
        this.FIREBASE_INSTANCE_ID_TOKEN = "cSDnCyp3T-uwp07z3tL86T:APA91bFkmvvsHw5nnqa1SBFci-99DRsKClLiETdRrVcJjS5yBx1v_FbCb1d8WhBuea_zmwnYBktyTIzcRhN4b6uNOUur9wPc0gKXmJDoZic0LhNq5V2s0xI";
        this.HEADERS = {
            "Content-Type": "application/json",
            "X-Android-Package": "com.alightcreative.motion",
            "X-Android-Cert": "ECA6BF91B8715A6F810ED0BBFC65B6CD578F52A8",
            "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 15; 23127PN0CC Build/BP1A.250505.005)"
        };
    }

    generateCodeOrder() {
        return crypto.randomInt(10000, 99999).toString();
    }

    extractOobCode(fullUrl) {
        if (!fullUrl) return null;
        try {
            let cleanUrl = fullUrl.replace(/&amp;/g, '&');
            try { cleanUrl = decodeURIComponent(cleanUrl); } catch(e) {}
            
            try {
                const urlObj = new URL(cleanUrl);
                let oobCode = urlObj.searchParams.get('oobCode');
                if (!oobCode) {
                    const nestedLink = urlObj.searchParams.get('link') || urlObj.searchParams.get('q') || urlObj.searchParams.get('url');
                    if (nestedLink) {
                        try {
                            const innerUrlObj = new URL(nestedLink);
                            oobCode = innerUrlObj.searchParams.get('oobCode');
                        } catch (e) {}
                    }
                }
                if (oobCode) return oobCode.replace(/[^a-zA-Z0-9_-]/g, '');
            } catch (e) {}

            const match = cleanUrl.match(/[?&]oobCode=([a-zA-Z0-9_-]+)/i) || cleanUrl.match(/oobCode=([a-zA-Z0-9_-]+)/i);
            if (match && match[1]) {
                return match[1];
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    async sendMagicLink(email) {
        try {
            await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/createAuthUri?key=${this.API_KEY}`, { identifier: email, continueUri: "http://localhost" }, { headers: this.HEADERS });
            await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/getOobConfirmationCode?key=${this.API_KEY}`, {
                requestType: 6,
                email: email,
                androidInstallApp: true,
                canHandleCodeInApp: true,
                continueUrl: "https://alightcreative.com?ui_sid=0366624874&ui_sd=0",
                iosBundleId: "com.alightcreative.motion",
                androidPackageName: "com.alightcreative.motion",
                androidMinimumVersion: "585",
                clientType: "CLIENT_TYPE_ANDROID"
            }, { headers: this.HEADERS });
            return { success: true, message: "Link berhasil dikirim." };
        } catch (error) {
            const errData = error.response?.data ? (typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data) : error.message;
            return { success: false, error: errData };
        }
    }

    async verifyAndFetchProfile(email, rawLink) {
        try {
            const oobCode = this.extractOobCode(rawLink);
            if (!oobCode) throw new Error("Gagal mengekstrak oobCode.");
            const signinRes = await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/emailLinkSignin?key=${this.API_KEY}`, {
                email: email,
                oobCode: oobCode,
                clientType: "CLIENT_TYPE_ANDROID"
            }, { headers: this.HEADERS });

            const accountRes = await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${this.API_KEY}`, { idToken: signinRes.data.idToken }, { headers: this.HEADERS });
            return { success: true, idToken: signinRes.data.idToken, user: accountRes.data.users[0] };
        } catch (error) {
            const errData = error.response?.data ? (typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data) : error.message;
            return { success: false, error: errData };
        }
    }

    async applyPremium(idToken, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const codeorder = this.generateCodeOrder();
      const timestamp = Date.now().toString().slice(-6);
      const orderId = `${this.ORDER_ID}-${codeorder}-${timestamp}`;

      console.log(`[applyPremium] Attempt ${attempt}/${retries} - OrderID: ${orderId}`);

      const url = 'https://us-central1-alight-creative.cloudfunctions.net/verifyPurchase';
      const headers = {
        "authorization": "Bearer " + idToken,
        "firebase-instance-id-token": this.FIREBASE_INSTANCE_ID_TOKEN,
        "content-type": "application/json; charset=utf-8",
        "accept-encoding": "gzip",
        "user-agent": "okhttp/3.12.1"
      };

      const payload = {
        data: {
          productId: this.PRODUCT_ID,
          token: this.TOKEN,
          skuType: this.SKU_TYPE,
          orderId: orderId
        }
      };

      const response = await axios.post(url, payload, {
        headers: headers,
        timeout: 30000
      });

      console.log(`[applyPremium] Response status: ${response.status}`);
      console.log(`[applyPremium] Response data:`, JSON.stringify(response.data).slice(0, 500));

      if (response.status === 200 && response.data?.success !== false) {
        console.log(`[✅] Premium applied successfully! Order: ${orderId}`);
        return {
          success: true,
          data: response.data,
          codeorder: codeorder,
          orderId: orderId
        };
      } else {
        console.log(`[!] Attempt ${attempt} failed with status: ${response.status}`);
        if (response.data?.error) {
          console.log(`[!] Error detail:`, JSON.stringify(response.data.error));
        }
      }

    } catch (error) {
      console.error(`[!] Attempt ${attempt} error:`, error.message);
      if (error.response) {
        console.error(`[!] Response status:`, error.response.status);
        console.error(`[!] Response data:`, JSON.stringify(error.response.data || {}));
        
        // 🔥 KALO ERROR 400/403, TOKEN UDAH EXPIRED
        if (error.response.status === 400 || error.response.status === 403) {
          console.log('[!] ❌ TOKEN EXPIRED! Cari token baru dari APK Alight Motion.');
          return {
            success: false,
            error: "TOKEN_EXPIRED - Cari token baru dari APK Alight Motion",
            status: error.response.status
          };
        }
      }

      if (attempt === retries) {
        return {
          success: false,
          error: error.message || 'Max retries exceeded'
        };
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return { success: false, error: 'Max retries exceeded' };
}
}

module.exports = AlightMotionAuth;