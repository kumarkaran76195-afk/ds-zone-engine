package com.karan.admin;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

public class MainActivity extends Activity {
    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        try {
            super.onCreate(savedInstanceState);

            webView = new WebView(this);
            setContentView(webView);

            WebSettings s = webView.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setUseWideViewPort(true);
            s.setLoadWithOverviewMode(true);
            s.setSupportZoom(false);
            s.setBuiltInZoomControls(false);
            s.setCacheMode(WebSettings.LOAD_NO_CACHE);

            webView.setWebViewClient(new WebViewClient());
            webView.setBackgroundColor(0xFF0A0A0F);
            WebView.setWebContentsDebuggingEnabled(true);
            webView.loadUrl("https://ds-zone-engine-production.up.railway.app/admin.html");
        } catch (Throwable t) {
            KaranApp.report("onCreate", t);
            try {
                TextView tv = new TextView(this);
                tv.setText("App error:\n\n" + String.valueOf(t) + "\n\nReport bhej diya gaya.");
                tv.setTextColor(0xFFFF4757);
                tv.setBackgroundColor(0xFF0A0A0F);
                tv.setTextSize(13);
                tv.setPadding(48, 48, 48, 48);
                setContentView(tv);
            } catch (Throwable ignored) {
                Log.e("KaranCrash", "fallback UI failed", t);
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
