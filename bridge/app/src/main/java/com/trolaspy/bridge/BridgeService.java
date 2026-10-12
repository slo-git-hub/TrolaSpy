package com.trolaspy.bridge;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Listens for Victron "Instant readout" Bluetooth broadcasts and sends the newest one from each
 * device to TrolaSpy once a minute. It never connects to the devices, so VictronConnect keeps
 * working. The broadcasts stay encrypted here; TrolaSpy holds the keys and reads them.
 */
public class BridgeService extends Service {
    static final int VICTRON = 0x02E1; // Victron's Bluetooth company id
    static final long UPLOAD_EVERY_S = 60;
    static final long RESCAN_EVERY_S = 15 * 60; // a fresh scan now and then, in case Android stalls one
    static final String CHANNEL = "bridge";

    /** What the screen shows: devices heard and how the last upload went. */
    static final Map<String, Heard> heard = Collections.synchronizedMap(new LinkedHashMap<>());
    static volatile String lastUpload = "Not sent yet";
    static volatile String scanState = "Not started";
    static volatile boolean running = false;

    static class Heard {
        String mac, name, data;
        int rssi;
        long at; // System.currentTimeMillis()
    }

    private ScheduledExecutorService timer;
    private BluetoothLeScanner scanner;
    private PowerManager.WakeLock wakeLock;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("bridge", MODE_PRIVATE);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Bridge running", NotificationManager.IMPORTANCE_LOW));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(1, notification("Listening for Victron devices"));
        if (!running) {
            running = true;
            PowerManager pm = getSystemService(PowerManager.class);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TrolaSpyBridge:listen");
            wakeLock.acquire();
            timer = Executors.newSingleThreadScheduledExecutor();
            timer.scheduleWithFixedDelay(this::upload, 20, UPLOAD_EVERY_S, TimeUnit.SECONDS);
            timer.scheduleWithFixedDelay(this::restartScan, 0, RESCAN_EVERY_S, TimeUnit.SECONDS);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (timer != null) timer.shutdownNow();
        stopScan();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        scanState = "Stopped";
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- Bluetooth ----------

    private final ScanCallback callback = new ScanCallback() {
        @Override
        public void onScanResult(int type, ScanResult result) {
            take(result);
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            for (ScanResult r : results) take(r);
        }

        @Override
        public void onScanFailed(int errorCode) {
            scanState = "Bluetooth scan failed (error " + errorCode + "). Trying again soon.";
        }
    };

    private void take(ScanResult r) {
        ScanRecord rec = r.getScanRecord();
        if (rec == null) return;
        byte[] data = rec.getManufacturerSpecificData(VICTRON);
        if (data == null || data.length < 9 || data[0] != 0x10) return; // 0x10: an Instant readout
        String mac = r.getDevice().getAddress();
        Heard h = heard.get(mac);
        if (h == null) {
            h = new Heard();
            h.mac = mac;
            heard.put(mac, h);
        }
        if (rec.getDeviceName() != null) h.name = rec.getDeviceName();
        h.data = hex(data);
        h.rssi = r.getRssi();
        h.at = System.currentTimeMillis();
    }

    @SuppressLint("MissingPermission") // asked for on the main screen; a refusal shows up as an error here
    private synchronized void restartScan() {
        stopScan();
        BluetoothManager bm = getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            scanState = "Bluetooth is off. Turn it on and the app starts listening within 15 minutes.";
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            scanState = "Bluetooth isn't ready yet.";
            return;
        }
        // A filter is needed for scanning to go on with the screen off.
        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setManufacturerData(VICTRON, new byte[] {0x10}).build());
        ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build();
        try {
            scanner.startScan(filters, settings, callback);
            scanState = "Listening since " + DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date());
        } catch (SecurityException e) {
            scanState = "No permission to use Bluetooth. Open the app and allow it.";
            scanner = null;
        }
    }

    @SuppressLint("MissingPermission")
    private synchronized void stopScan() {
        if (scanner == null) return;
        try {
            scanner.stopScan(callback);
        } catch (Exception ignored) {
            // Bluetooth was switched off, or the permission was taken away
        }
        scanner = null;
    }

    // ---------- Upload ----------

    private void upload() {
        try {
            SharedPreferences p = prefs(this);
            String server = p.getString("server", "").trim().replaceAll("/+$", "");
            if (server.isEmpty()) {
                lastUpload = "No server set";
                return;
            }
            long now = System.currentTimeMillis();
            JSONArray devices = new JSONArray();
            synchronized (heard) {
                for (Heard h : heard.values()) {
                    if (now - h.at > 3600_000L) continue; // not heard for an hour
                    JSONObject d = new JSONObject();
                    d.put("mac", h.mac);
                    d.put("name", h.name == null ? "" : h.name);
                    d.put("rssi", h.rssi);
                    d.put("data", h.data);
                    d.put("age_ms", now - h.at);
                    devices.put(d);
                }
            }
            JSONObject body = new JSONObject();
            body.put("app", "TrolaSpy Bridge " + version(this));
            body.put("devices", devices);

            HttpURLConnection c = (HttpURLConnection) new URL(server + "/bridge").openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(15000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            String auth = p.getString("user", "") + ":" + p.getString("pass", "");
            c.setRequestProperty("Authorization", "Basic " + Base64.encodeToString(auth.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
            try (OutputStream out = c.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = c.getResponseCode();
            String reply = read(code < 400 ? c.getInputStream() : c.getErrorStream());
            c.disconnect();
            String time = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date());
            if (code == 200) {
                JSONObject j = new JSONObject(reply);
                lastUpload = "Sent at " + time + ": " + j.optInt("heard") + " heard, " + j.optInt("read") + " read";
            } else {
                String why = reply;
                try { why = new JSONObject(reply).optString("error", reply); } catch (Exception ignored) { }
                lastUpload = "Not sent at " + time + " (" + code + "): " + why;
            }
        } catch (Exception e) {
            lastUpload = "Not sent: " + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : " " + e.getMessage());
        }
        getSystemService(NotificationManager.class).notify(1, notification(heard.size() + " Victron devices · " + lastUpload));
    }

    private static String read(InputStream in) throws java.io.IOException {
        if (in == null) return "";
        try (InputStream s = in) {
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = s.read(buf)) > 0) b.write(buf, 0, n);
            return b.toString("UTF-8");
        }
    }

    static String version(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    static String hex(byte[] bytes) {
        StringBuilder s = new StringBuilder();
        for (byte b : bytes) s.append(String.format("%02x", b & 0xff));
        return s.toString();
    }

    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle("TrolaSpy Bridge")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }
}
