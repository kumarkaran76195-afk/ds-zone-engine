package com.karan.admin;

import android.app.Application;
import android.os.Build;
import android.util.Log;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class KaranApp extends Application {
    private static final String CRASH_URL = "https://ds-zone-engine-production.up.railway.app/api/crash";

    @Override
    public void onCreate() {
        super.onCreate();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                report("uncaught:" + t.getName(), e);
                try { Thread.sleep(2500); } catch (InterruptedException ignored) {}
                System.exit(1);
            }
        });
    }

    public static void report(final String where, final Throwable e) {
        final String stack = where + " | " + Build.MODEL + " | Android " + Build.VERSION.RELEASE + "\n" + Log.getStackTraceString(e);
        Log.e("KaranCrash", stack);
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(CRASH_URL).openConnection();
                    c.setConnectTimeout(5000);
                    c.setReadTimeout(5000);
                    c.setRequestMethod("POST");
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    String body = "{\"model\":\"" + esc(Build.MODEL)
                            + "\",\"android\":\"" + esc(Build.VERSION.RELEASE)
                            + "\",\"where\":\"" + esc(where)
                            + "\",\"stack\":\"" + esc(stack) + "\"}";
                    OutputStream os = c.getOutputStream();
                    os.write(body.getBytes("UTF-8"));
                    os.close();
                    c.getResponseCode();
                    c.disconnect();
                } catch (Throwable ignored) {}
            }
        }).start();
    }

    static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "");
    }
}
