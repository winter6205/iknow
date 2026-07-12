import { AppShell } from "./components/AppShell";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { G2Panel } from "./components/G2Panel";
import { MessageList } from "./components/MessageList";
import { StateBlock } from "./components/StateBlock";
import { useSessionChat } from "./hooks/useSessionChat";

function ChatApp() {
  const chat = useSessionChat();

  const header = (
    <ChatHeader
      session={chat.session}
      phase={chat.phase}
      healthLabel={chat.healthLabel}
      mode={chat.mode}
      role={chat.role}
      onModeChange={(m) => {
        void chat.setMode(m);
      }}
      onRoleChange={(r) => {
        void chat.setRole(r);
      }}
      onReset={() => {
        void chat.reset();
      }}
      onNewSession={() => {
        void chat.newSession();
      }}
    />
  );

  const side = <G2Panel session={chat.session} answer={chat.lastAnswer} />;

  if (chat.phase === "loading" && !chat.session) {
    return (
      <AppShell
        header={header}
        side={side}
        main={
          <StateBlock
            kind="loading"
            title="正在连接会话服务…"
            detail={chat.healthLabel ?? "检查 /api/v1/health 并创建会话"}
          />
        }
      />
    );
  }

  if (chat.phase === "error" && !chat.session) {
    return (
      <AppShell
        header={header}
        side={side}
        main={
          <StateBlock
            kind="error"
            title="无法启动会话"
            detail={chat.error ?? "未知错误"}
            onRetry={chat.retryBootstrap}
            retryLabel="重新连接"
          />
        }
      />
    );
  }

  return (
    <AppShell
      header={header}
      side={side}
      main={
        <>
          {chat.error ? (
            <StateBlock
              kind="error"
              title="请求失败"
              detail={chat.error}
              onRetry={
                chat.session
                  ? () => {
                      /* clear by reset path; composer can resend */
                      void chat.reset();
                    }
                  : chat.retryBootstrap
              }
              retryLabel={chat.session ? "重置会话" : "重试"}
            />
          ) : null}
          <MessageList messages={chat.messages} />
        </>
      }
      footer={
        <Composer
          disabled={!chat.session || chat.phase === "loading"}
          sending={chat.phase === "sending"}
          onSend={chat.sendMessage}
        />
      }
    />
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ChatApp />
    </ErrorBoundary>
  );
}
