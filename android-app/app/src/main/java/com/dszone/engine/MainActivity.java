package com.dszone.engine;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;

import com.google.android.gms.ads.AdListener;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;

public class MainActivity extends Activity {
    private static final String AD_UNIT_ID = "ca-app-pub-7437798527438695/7763545107";
    private static final String TAG = "DSAd";

    private WebView webView;
    private AdView adView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF0A0A0F);

        webView = new WebView(this);
        LinearLayout.LayoutParams webLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        root.addView(webView, webLp);

        try {
            adView = new AdView(this);
            adView.setAdUnitId(AD_UNIT_ID);
            adView.setAdSize(AdSize.BANNER);
            adView.setVisibility(View.GONE);
            LinearLayout.LayoutParams adLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            root.addView(adView, adLp);
        } catch (Throwable t) {
            Log.w(TAG, "AdView create failed", t);
            adView = null;
        }

        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return handleLink(req.getUrl().toString());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleLink(url);
            }
        });
        webView.setBackgroundColor(0xFF0A0A0F);
        webView.loadUrl("https://ds-zone-engine-production.up.railway.app/");

        if (adView != null) {
            try {
                final AdView av = adView;
                av.setAdListener(new AdListener() {
                    @Override
                    public void onAdLoaded() {
                        av.setVisibility(View.VISIBLE);
                    }

                    @Override
                    public void onAdFailedToLoad(LoadAdError e) {
                        Log.w(TAG, "ad failed: " + e.getCode() + " " + e.getMessage());
                        av.setVisibility(View.GONE);
                    }
                });
                MobileAds.initialize(this, initStatus -> {});
                av.loadAd(new AdRequest.Builder().build());
            } catch (Throwable t) {
                Log.w(TAG, "ad init failed", t);
            }
        }
    }

    private boolean handleLink(String url) {
        if (url == null) return false;
        String u = url.toLowerCase(java.util.Locale.ROOT);
        boolean external = u.startsWith("whatsapp://")
                || u.contains("wa.me/")
                || u.contains("whatsapp.com/")
                || u.startsWith("intent:")
                || u.startsWith("mailto:")
                || u.startsWith("tel:");
        if (!external) return false;
        try {
            String target = url;
            if (u.contains("wa.me/") || u.contains("whatsapp.com/send")) {
                String text = null;
                int qi = url.indexOf("?text=");
                if (qi >= 0) text = url.substring(qi + 6);
                String phone = "916239883897";
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("(?:wa\\.me/|whatsapp\\.com/send\\?phone=)(\\d+)").matcher(url);
                if (m.find()) phone = m.group(1);
                target = "whatsapp://send?phone=" + phone + (text != null ? "&text=" + text : "");
            }
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(target));
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable t) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Throwable t2) {
                Log.w(TAG, "no app for " + url);
            }
        }
        return true;
    }

    @Override
    protected void onDestroy() {
        try {
            if (adView != null) adView.destroy();
        } catch (Throwable ignored) {}
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
