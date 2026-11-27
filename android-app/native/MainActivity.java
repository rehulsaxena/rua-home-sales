package in.ruahome.sales;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.os.Bundle;
import android.text.InputType;
import android.webkit.HttpAuthHandler;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    final WebView webView = this.getBridge().getWebView();
    webView.setWebViewClient(new BridgeWebViewClient(this.getBridge()) {
      @Override
      public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
        String[] stored = view.getHttpAuthUsernamePassword(host, realm);
        if (stored != null && stored.length == 2 && stored[0] != null && stored[0].length() > 0) {
          handler.proceed(stored[0], stored[1]);
          return;
        }
        promptForCredentials(view, handler, host, realm);
      }
    });
  }
  private void promptForCredentials(final WebView view, final HttpAuthHandler handler, final String host, final String realm) {
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    int pad = 48;
    layout.setPadding(pad, pad, pad, pad);
    TextView label = new TextView(this);
    label.setText("Enter the pilot sign-in details to continue.");
    label.setPadding(0, 0, 0, 24);
    layout.addView(label);
    final EditText userField = new EditText(this);
    userField.setHint("Username");
    layout.addView(userField);
    final EditText passField = new EditText(this);
    passField.setHint("Password");
    passField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    layout.addView(passField);
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("Sign in to RUA HOME Sales")
      .setView(layout)
      .setCancelable(false)
      .setPositiveButton("Sign in", new DialogInterface.OnClickListener() {
        @Override
        public void onClick(DialogInterface d, int which) {
          String user = userField.getText().toString();
          String pass = passField.getText().toString();
          view.setHttpAuthUsernamePassword(host, realm, user, pass);
          handler.proceed(user, pass);
        }
      })
      .setNegativeButton("Cancel", new DialogInterface.OnClickListener() {
        @Override
        public void onClick(DialogInterface d, int which) {
          handler.cancel();
        }
      })
      .create();
    dialog.show();
  }
}
