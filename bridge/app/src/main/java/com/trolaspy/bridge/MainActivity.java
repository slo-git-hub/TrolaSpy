package com.trolaspy.bridge;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** Server details, permissions, start / stop, and what the bridge hears right now. */
public class MainActivity extends Activity {
    private EditText server, user, pass;
    private TextView status, heard;
    private Button battery;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean asked = false; // permissions asked for once per tap, so a refusal can't loop

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            showStatus();
            ui.postDelayed(this, 2000);
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        int pad = dp(16);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);

        TextView title = text("TrolaSpy Bridge", 22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title);
        col.addView(text("Passes the Victron solar and DC-DC chargers' Bluetooth readings on to TrolaSpy. "
                + "Use the same user name and password as LeafSpy. The server address is on the TrolaSpy page, Admin, Solar.", 14));

        SharedPreferences p = BridgeService.prefs(this);
        server = field(col, "Server", p.getString("server", ""), InputType.TYPE_TEXT_VARIATION_URI);
        server.setHint("https://trolaspy-ingest.….workers.dev");
        user = field(col, "User name", p.getString("user", ""), InputType.TYPE_CLASS_TEXT);
        pass = field(col, "Password", p.getString("pass", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);

        Button start = new Button(this);
        start.setText("Save and start");
        start.setOnClickListener(v -> {
            asked = false;
            saveAndStart();
        });
        col.addView(start);

        Button stop = new Button(this);
        stop.setText("Stop");
        stop.setOnClickListener(v -> {
            BridgeService.prefs(this).edit().putBoolean("on", false).apply();
            stopService(new Intent(this, BridgeService.class));
        });
        col.addView(stop);

        battery = new Button(this);
        battery.setText("Let it run in the background");
        battery.setOnClickListener(v -> askBattery());
        col.addView(battery);

        status = text("", 14);
        status.setPadding(0, dp(12), 0, 0);
        col.addView(status);
        heard = text("", 14);
        heard.setTypeface(Typeface.MONOSPACE);
        heard.setPadding(0, dp(8), 0, 0);
        col.addView(heard);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col);
        setContentView(scroll);
        // It was on, but Android stopped it: start it again.
        if (p.getBoolean("on", false) && !BridgeService.running) saveAndStart();
    }

    @Override
    protected void onResume() {
        super.onResume();
        ui.post(tick);
    }

    @Override
    protected void onPause() {
        ui.removeCallbacks(tick);
        super.onPause();
    }

    private void saveAndStart() {
        BridgeService.prefs(this).edit()
                .putString("server", server.getText().toString().trim())
                .putString("user", user.getText().toString().trim())
                .putString("pass", pass.getText().toString())
                .putBoolean("on", true)
                .apply();
        List<String> need = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            need.add(Manifest.permission.BLUETOOTH_SCAN);
        } else {
            need.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33) need.add(Manifest.permission.POST_NOTIFICATIONS);
        List<String> missing = new ArrayList<>();
        for (String perm : need) if (checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) missing.add(perm);
        if (!missing.isEmpty() && !asked) {
            asked = true;
            requestPermissions(missing.toArray(new String[0]), 1);
            return;
        }
        if (checkSelfPermission(need.get(0)) != PackageManager.PERMISSION_GRANTED) {
            status.setText(Build.VERSION.SDK_INT >= 31
                    ? "The app needs the \"Nearby devices\" permission to hear the chargers. Tap Save and start again, or allow it in Android's app settings."
                    : "The app needs the location permission to scan for Bluetooth devices. Tap Save and start again, or allow it in Android's app settings.");
            return;
        }
        // Android 10 and 11 only let a scan started after a restart find devices with "Allow all the time".
        if (Build.VERSION.SDK_INT >= 29 && Build.VERSION.SDK_INT <= 30
                && checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED
                && !BridgeService.prefs(this).getBoolean("asked_bg", false)) {
            BridgeService.prefs(this).edit().putBoolean("asked_bg", true).apply();
            requestPermissions(new String[] {Manifest.permission.ACCESS_BACKGROUND_LOCATION}, 2);
            return;
        }
        startForegroundService(new Intent(this, BridgeService.class));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        saveAndStart();
    }

    @SuppressLint("BatteryLife") // the app's whole job is to keep listening
    private void askBattery() {
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm.isIgnoringBatteryOptimizations(getPackageName())) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        } else {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        }
    }

    private void showStatus() {
        PowerManager pm = getSystemService(PowerManager.class);
        boolean free = pm.isIgnoringBatteryOptimizations(getPackageName());
        battery.setVisibility(free ? View.GONE : View.VISIBLE);
        StringBuilder s = new StringBuilder();
        s.append(BridgeService.running ? "Running. " : "Not running. ").append(BridgeService.scanState).append('\n');
        s.append(BridgeService.lastUpload).append('\n');
        if (!free) s.append("Android may pause the app to save battery. Tap the button above to let it run.\n");
        s.append("Version ").append(BridgeService.version(this));
        status.setText(s);

        StringBuilder h = new StringBuilder("Victron devices heard:\n");
        long now = System.currentTimeMillis();
        synchronized (BridgeService.heard) {
            if (BridgeService.heard.isEmpty()) h.append("none yet");
            for (BridgeService.Heard d : BridgeService.heard.values()) {
                h.append(d.name == null ? d.mac : d.name)
                        .append("  ").append(d.rssi).append(" dBm  ")
                        .append((now - d.at) / 1000).append(" s ago\n");
            }
        }
        heard.setText(h);
    }

    private EditText field(LinearLayout col, String label, String value, int type) {
        TextView l = text(label, 14);
        l.setPadding(0, dp(12), 0, 0);
        col.addView(l);
        EditText e = new EditText(this);
        e.setSingleLine(true);
        e.setInputType(type);
        e.setText(value);
        col.addView(e);
        return e;
    }

    private TextView text(String s, int sp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
