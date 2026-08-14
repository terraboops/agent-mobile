package com.agentmobile.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

/**
 * AudioService — foreground service that keeps the process legitimately
 * foreground-active while the mic is capturing. Modern Android silences mic
 * capture from an app that is not judged foreground-active (OpRecordAudioMonitor
 * in AUDIOSOURCE AudioRecordClient.cpp: checkOp != MODE_ALLOWED). Declaring a
 * foreground service of type microPHONE is the documented way to keep the check
 * satisfied for sustained full-duplex capture.
 */
public class AudioService extends Service {
    private static final String CHANNEL = "agent-audio";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel nc = new NotificationChannel(CHANNEL, "Agent audio",
                NotificationManager.IMPORTANCE_LOW);
        nc.setShowBadge(false);
        nc.setSound(null, null);
        nm.createNotificationChannel(nc);

        Notification n = new Notification.Builder(this, CHANNEL)
                .setContentTitle("Agent")
                .setContentText("Microphone active")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .build();
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
