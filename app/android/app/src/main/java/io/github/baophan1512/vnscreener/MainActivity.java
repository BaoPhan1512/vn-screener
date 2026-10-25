package io.github.baophan1512.vnscreener;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Nút Quay lại: hỏi website trước (đóng biểu đồ / hộp thoại), không còn gì để đóng thì thoát app
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript(
                    "(window.__vnsBack && window.__vnsBack()) ? '1' : '0'",
                    value -> {
                        if (!"\"1\"".equals(value)) {
                            setEnabled(false);
                            getOnBackPressedDispatcher().onBackPressed();
                            setEnabled(true);
                        }
                    });
            }
        });
    }
}
