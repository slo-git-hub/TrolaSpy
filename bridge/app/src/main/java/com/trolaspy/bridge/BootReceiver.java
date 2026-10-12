package com.trolaspy.bridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts listening again after the tablet restarts or the app is updated, if it was on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!BridgeService.prefs(context).getBoolean("on", false)) return;
        try {
            context.startForegroundService(new Intent(context, BridgeService.class));
        } catch (Exception ignored) {
            // Android refused to start it from here; opening the app starts it
        }
    }
}
